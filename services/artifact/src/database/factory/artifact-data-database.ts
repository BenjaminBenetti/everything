import { DataSource } from "typeorm";
import {
  connectionOptions,
  type DatabaseConnectionSettings,
} from "../../persistence/factory/artifact-database.js";

/** Connect to the database holding every artifact's schema, as the role that owns it. */
export function createArtifactDataDatabase(
  settings: DatabaseConnectionSettings,
  database: string,
): DataSource {
  return new DataSource({
    ...connectionOptions(settings),
    database,
    poolSize: 2,
    synchronize: false,
    logging: false,
  });
}
