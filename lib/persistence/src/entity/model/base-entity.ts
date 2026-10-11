/** Identity and creation time shared by persisted domain entities. */
export interface BaseEntity {
  readonly id: string;
  readonly createdAt: string;
}

/** A persisted entity directly owned by an authenticated subject. */
export interface OwnedEntity extends BaseEntity {
  readonly ownerId: string;
}
