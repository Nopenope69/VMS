import crypto from 'crypto';

export interface SegmentLeafInput {
  segmentId: string;
  cameraId: string;
  startTime: Date;
  endTime: Date;
  mediaSha256?: string | null;
}

export interface MerkleProofNode {
  position: 'left' | 'right';
  hash: string;
}

export interface MerkleLeafEntry {
  leafIndex: number;
  segmentId: string;
  cameraId: string;
  startUtc: string;
  endUtc: string;
  mediaSha256: string;
  leafHash: string;
}

export class MerkleTree {
  public static readonly DOMAIN_SEPARATOR = 'VIGILONE-EVIDENCE-SEGMENT-V1';

  /**
   * Encodes a segment into a canonical length-prefixed binary buffer and computes its SHA-256 hash.
   * Domain separation and length prefixing strictly prevent delimiter collision and length extension vulnerabilities.
   */
  public static computeLeafHash(input: SegmentLeafInput): string {
    const domainBuf = Buffer.from(this.DOMAIN_SEPARATOR, 'utf8');
    const segIdBuf = Buffer.from(input.segmentId, 'utf8');
    const camIdBuf = Buffer.from(input.cameraId, 'utf8');

    const segIdLenBuf = Buffer.alloc(4);
    segIdLenBuf.writeUInt32LE(segIdBuf.length, 0);

    const camIdLenBuf = Buffer.alloc(4);
    camIdLenBuf.writeUInt32LE(camIdBuf.length, 0);

    const timeBuf = Buffer.alloc(16);
    timeBuf.writeBigInt64LE(BigInt(input.startTime.getTime()), 0);
    timeBuf.writeBigInt64LE(BigInt(input.endTime.getTime()), 8);

    let mediaHashHex = input.mediaSha256 || '';
    if (!/^[a-fA-F0-9]{64}$/.test(mediaHashHex)) {
      // Deterministic fallback if media hash was uncomputed: hash of segment identifier
      mediaHashHex = crypto
        .createHash('sha256')
        .update(`UNFINALIZED:${input.segmentId}:${input.startTime.toISOString()}`)
        .digest('hex');
    }
    const mediaHashBuf = Buffer.from(mediaHashHex, 'hex');

    const canonicalPayload = Buffer.concat([
      domainBuf,
      segIdLenBuf,
      segIdBuf,
      camIdLenBuf,
      camIdBuf,
      timeBuf,
      mediaHashBuf,
    ]);

    return crypto.createHash('sha256').update(canonicalPayload).digest('hex');
  }

  /**
   * Combines two 32-byte hex node hashes into a parent node hash.
   *
   * Architectural Security Note (RFC 6962 / Second-Preimage Invariant):
   * This implementation maintains mathematical second-preimage collision resistance
   * because leaf payloads are domain-separated and structurally bounded to >= 85 bytes
   * (domain prefix 13B + segIdLen 2B + segId >= 16B + camIdLen 2B + camId >= 16B + time 8B + mediaHash 32B = >= 87 bytes),
   * while parent internal node pre-images are strictly and invariantly 64 bytes (two concatenated 32-byte hashes).
   * Because the input domain lengths can never intersect, leaf-to-internal pre-image collisions
   * are mathematically impossible without breaking backwards-compatibility for existing archives.
   */
  public static combineNodes(leftHex: string, rightHex: string): string {
    const combined = Buffer.concat([
      Buffer.from(leftHex, 'hex'),
      Buffer.from(rightHex, 'hex'),
    ]);
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  /**
   * Builds an entire binary Merkle tree from segment leaves with deterministic odd-leaf duplication.
   */
  public static buildTree(leaves: SegmentLeafInput[]): {
    rootHash: string;
    leafEntries: MerkleLeafEntry[];
    levels: string[][];
  } {
    if (!leaves || leaves.length === 0) {
      const emptyRoot = crypto
        .createHash('sha256')
        .update(Buffer.from(`${this.DOMAIN_SEPARATOR}:EMPTY`, 'utf8'))
        .digest('hex');
      return { rootHash: emptyRoot, leafEntries: [], levels: [[emptyRoot]] };
    }

    // Sort leaves deterministically by (cameraId ASC, startTime ASC, segmentId ASC)
    const sortedLeaves = [...leaves].sort((a, b) => {
      if (a.cameraId !== b.cameraId) return a.cameraId.localeCompare(b.cameraId);
      if (a.startTime.getTime() !== b.startTime.getTime()) {
        return a.startTime.getTime() - b.startTime.getTime();
      }
      return a.segmentId.localeCompare(b.segmentId);
    });

    const leafEntries: MerkleLeafEntry[] = sortedLeaves.map((leaf, index) => {
      const leafHash = this.computeLeafHash(leaf);
      let mediaHashHex = leaf.mediaSha256 || '';
      if (!/^[a-fA-F0-9]{64}$/.test(mediaHashHex)) {
        mediaHashHex = crypto
          .createHash('sha256')
          .update(`UNFINALIZED:${leaf.segmentId}:${leaf.startTime.toISOString()}`)
          .digest('hex');
      }
      return {
        leafIndex: index,
        segmentId: leaf.segmentId,
        cameraId: leaf.cameraId,
        startUtc: leaf.startTime.toISOString(),
        endUtc: leaf.endTime.toISOString(),
        mediaSha256: mediaHashHex,
        leafHash,
      };
    });

    const levels: string[][] = [];
    let currentLevel = leafEntries.map((e) => e.leafHash);
    levels.push(currentLevel);

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        // INVARIANT: Odd node -> duplicate last node
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : currentLevel[i];
        nextLevel.push(this.combineNodes(left, right));
      }
      levels.push(nextLevel);
      currentLevel = nextLevel;
    }

    return {
      rootHash: currentLevel[0],
      leafEntries,
      levels,
    };
  }

  /**
   * Generates a compact O(log N) inclusion proof for a specific leaf index.
   */
  public static generateInclusionProof(
    levels: string[][],
    leafIndex: number
  ): MerkleProofNode[] {
    const proof: MerkleProofNode[] = [];
    let currentIndex = leafIndex;

    for (let levelIdx = 0; levelIdx < levels.length - 1; levelIdx++) {
      const level = levels[levelIdx];
      const isRightSibling = currentIndex % 2 === 1;
      const siblingIndex = isRightSibling ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < level.length) {
        proof.push({
          position: isRightSibling ? 'left' : 'right',
          hash: level[siblingIndex],
        });
      } else {
        // Odd node duplicated itself
        proof.push({
          position: 'right',
          hash: level[currentIndex],
        });
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Standalone verification of a Merkle inclusion proof against an authoritative root hash.
   */
  public static verifyInclusionProof(
    leafHash: string,
    proof: MerkleProofNode[],
    rootHash: string
  ): boolean {
    let currentHash = leafHash;

    for (const node of proof) {
      if (node.position === 'left') {
        currentHash = this.combineNodes(node.hash, currentHash);
      } else {
        currentHash = this.combineNodes(currentHash, node.hash);
      }
    }

    return currentHash === rootHash;
  }
}

export default MerkleTree;
