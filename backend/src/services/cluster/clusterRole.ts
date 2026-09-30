/** Lets the health route report this node's high-availability role without importing the server module. */
export type ClusterRole = { nodeId: string; role: 'LEADER' | 'FOLLOWER' } | null;

let source: () => ClusterRole = () => null;

export function setClusterRoleSource(fn: () => ClusterRole): void {
  source = fn;
}

export function clusterRole(): ClusterRole {
  return source();
}
