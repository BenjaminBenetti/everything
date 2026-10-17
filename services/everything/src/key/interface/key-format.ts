/** Format-specific behavior supplied independently of storage and management. */
export interface KeyFormat {
  /** Check an upload's format without making any connection or using the key. */
  accepts(material: string): boolean;
}
