/**
 * Run before every test file. INDEX_TREES=0 starts every object database with its secondary indices' B+ trees
 * dropped, so the suites exercise the fallback (STATE-PAGING.md section 4.2): lookups and scans from the index
 * store with the overlay of the writes since the last root on top.
 */
import { setDefaultIndexTrees } from '../src/db/database.ts';

if (process.env.INDEX_TREES === '0') setDefaultIndexTrees(false);
