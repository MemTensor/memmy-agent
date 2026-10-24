/** The browser permission selected by the user and any effective Computer Use grant. */
export type BrowserAllowAllState = {
  enabled: boolean;
  inherited: boolean;
  effective: boolean;
};

/** Desktop provides the existing Computer Use approval path to the managed Agent. */
export const BROWSER_NATIVE_ALLOW_ALL_FILE_ENV = 'MEMMY_NATIVE_APP_ALLOW_ALL_FILE';
