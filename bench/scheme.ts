/**
 * Imported first by every benchmark entry point, ahead of the modules that make keys as they load: CHAIN_SCHEME
 * picks the scheme the suites' keys and genesis files use.
 */
import { useSchemeFromEnvironment } from '../src/crypto/keys.ts';

useSchemeFromEnvironment();
