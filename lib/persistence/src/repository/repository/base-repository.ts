import type {
  FindManyOptions,
  FindOptionsWhere,
  Repository as OrmRepository,
} from "typeorm";
import type { BaseEntity } from "../../entity/model/base-entity.js";
import type { Repository } from "../interface/repository.js";
import { serializableTransaction } from "../../transaction/service/serializable-transaction.js";

export type { Repository, OwnerScope } from "../interface/repository.js";

/** Domain-defined ordering and retention applied to every listing. */
export type ListOptions<TRecord> = Pick<
  FindManyOptions<TRecord>,
  "order" | "take"
>;

/** Scoped defaults backed by TypeORM repositories and entity metadata. */
export abstract class BaseRepository<
  TEntity extends BaseEntity,
  TScope,
  TRecord extends BaseEntity = TEntity,
> implements Repository<TEntity, TScope> {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive a mapped repository and the domain's ordering/retention policy. */
  protected constructor(
    protected readonly orm: OrmRepository<TRecord>,
    private readonly listOptions: ListOptions<TRecord>,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Find an entity in scope; missing and inaccessible identifiers return undefined. */
  async getById(
    scope: TScope,
    id: TEntity["id"],
  ): Promise<TEntity | undefined> {
    const record = await this.orm.findOneBy(this.scopedWhere(scope, id));
    return record ? this.toEntity(record) : undefined;
  }

  /** Apply scope and domain-defined ordering/retention through TypeORM. */
  async list(scope: TScope): Promise<TEntity[]> {
    const records = await this.orm.find({
      ...this.listOptions,
      where: this.scopeFilter(scope),
    });
    return records.map((record) => this.toEntity(record));
  }

  /** Resolve ownership and remove in one serializable transaction, including relation scopes. */
  async delete(scope: TScope, id: TEntity["id"]): Promise<void> {
    const where = this.scopedWhere(scope, id);
    await serializableTransaction(this.orm.manager, async (manager) => {
      const repository = manager.getRepository(this.orm.target);
      const record = await repository.findOneBy(where);
      if (record) await repository.remove(record);
    });
  }

  // ===========================================
  // Domain policy
  // ===========================================

  /** Express ownership using mapped properties and ORM relation filters. */
  protected abstract scopeWhere(scope: TScope): FindOptionsWhere<TRecord>;

  /** Exclude persistence-only fields from the public entity. */
  protected abstract toEntity(record: TRecord): TEntity;

  // ===========================================
  // Query guards
  // ===========================================

  /** Refuse an omitted scope before TypeORM constructs a query. */
  private scopeFilter(scope: TScope): FindOptionsWhere<TRecord> {
    const where = this.scopeWhere(scope);
    if (!Object.keys(where).length)
      throw new Error("Repository operations require an explicit scope");
    return where;
  }

  /** Narrow the scope to one entity, refusing an omitted identifier that would broaden the query. */
  private scopedWhere(
    scope: TScope,
    id: TEntity["id"],
  ): FindOptionsWhere<TRecord> {
    if (!id) throw new Error("An entity identifier is required");
    return { ...this.scopeFilter(scope), id } as FindOptionsWhere<TRecord>;
  }
}
