import fs from 'fs';
import path from 'path';
import { FFmpegService } from '../services/ffmpeg/ffmpeg.service';

describe('FFmpeg Subprocess Service', () => {
  it('should return null when probing a non-existent file', async () => {
    const probe = await FFmpegService.probe('/tmp/non_existent_video_file_123.mp4');
    expect(probe).toBeNull();
  });

  it('should return null and not crash when probing a corrupted file', async () => {
    const corruptFile = path.join('/tmp', `corrupt_test_${Date.now()}.mp4`);
    fs.writeFileSync(corruptFile, 'this is random garbage not a valid mp4 container');

    const probe = await FFmpegService.probe(corruptFile);
    expect(probe).toBeNull();

    fs.unlinkSync(corruptFile);
  });

  it('should reject concatenation if empty segment list is provided', async () => {
    await expect(
      FFmpegService.concatSegments([], '/tmp/out.mp4')
    ).rejects.toThrow('No segments provided for concatenation');
  });
});
