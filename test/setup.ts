/**
 * Run before every test file. INDEX_TREES=0 starts every object database with its secondary indices' B+ trees
 * dropped, so the suites exercise the fallback (STATE-PAGING.md section 4.2): lookups and scans from the index
 * store with the overlay of the writes since the last root on top. TREES=0 starts every database with its Merkle
 * trees dropped (section 5.2): roots, proofs and key proofs from the chunks and nodes in the store. CHAIN_SCHEME
 * runs the suites on that scheme's keys.
 */
import { useSchemeFromEnvironment } from '../src/crypto/keys.ts';
import { setDefaultIndexTrees, setDefaultTrees } from '../src/db/database.ts';

useSchemeFromEnvironment();

if (process.env.INDEX_TREES === '0') setDefaultIndexTrees(false);
if (process.env.TREES === '0') setDefaultTrees(false);
