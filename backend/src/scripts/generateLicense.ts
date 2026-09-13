/**
 * Backward compatibility wrapper.
 * Diverts to mintLicense.ts which enforces offline key loading.
 */
import { runMint } from './mintLicense';

if (require.main === module) {
  runMint();
}
