import type {
  ApiDefinition,
  ApiDocumentationQuery,
} from "../model/api-documentation.js";

/** Tools and HTTP consumers can inspect definitions without accessing the application server. */
export interface ApiDocumentationReader {
  /** Return a complete definition or a filtered copy with its referenced components retained. */
  read(query?: ApiDocumentationQuery): ApiDefinition;
}

/** Only the HTTP composition boundary publishes the reflected definition. */
export interface ApiDocumentationPublisher {
  /** Capture the generated definition after every route has been registered. */
  publish(definition: ApiDefinition): void;
}
