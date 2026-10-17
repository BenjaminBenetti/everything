/** The installer's settings, which it saves in the cluster for upgrades to apply again. */
export interface InstallerSettings {
  /** Whether the installer has saved them; installations it has not upgraded since lack them. */
  saved(): Promise<boolean>;
}
