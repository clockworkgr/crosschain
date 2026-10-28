/**
 * Account names and asset symbols are human-readable unique keys, so they
 * are restricted to a small alphabet with one canonical spelling: no case
 * folding, no unicode lookalikes, nothing that needs normalising before it
 * goes into an index.
 */
export const MIN_ACCOUNT_NAME = 3;
export const MAX_ACCOUNT_NAME = 63;
export const MIN_ASSET_SYMBOL = 3;
export const MAX_ASSET_SYMBOL = 16;

/** Lowercase letters, digits, hyphens, in dot-separated segments that start with a letter and do not end with a hyphen. */
export function checkAccountName(name: string): string | null {
  if (name.length < MIN_ACCOUNT_NAME || name.length > MAX_ACCOUNT_NAME) return `account name must be ${MIN_ACCOUNT_NAME} to ${MAX_ACCOUNT_NAME} characters`;
  for (const seg of name.split('.')) {
    if (!/^[a-z][a-z0-9-]*$/.test(seg)) return 'account name segments must start with a letter and use only a-z, 0-9 and -';
    if (seg.endsWith('-')) return 'account name segments cannot end with -';
  }
  return null;
}

/** Uppercase letters and digits, in dot-separated segments that start with a letter. */
export function checkAssetSymbol(symbol: string): string | null {
  if (symbol.length < MIN_ASSET_SYMBOL || symbol.length > MAX_ASSET_SYMBOL) return `asset symbol must be ${MIN_ASSET_SYMBOL} to ${MAX_ASSET_SYMBOL} characters`;
  if (!/^[A-Z][A-Z0-9]*(\.[A-Z][A-Z0-9]*)*$/.test(symbol)) return 'asset symbol must be uppercase letters and digits, segments starting with a letter';
  return null;
}

/**
 * BitShares' is_cheap_name: a name with a digit, a dot or a hyphen, or with no
 * vowel at all, is cheap to register; every other name is premium (FEES.md).
 */
export function isCheapName(name: string): boolean {
  let vowel = false;
  for (const c of name) {
    if ((c >= '0' && c <= '9') || c === '.' || c === '-') return true;
    if ('aeiouy'.includes(c)) vowel = true;
  }
  return !vowel;
}
