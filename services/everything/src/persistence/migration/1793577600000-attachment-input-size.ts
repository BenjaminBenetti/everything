import {
  TableCheck,
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from "typeorm";

/** Separate input reservations/progress from encoded sizes; existing files stay untouched. */
export class AttachmentInputSize1793577600000 implements MigrationInterface {
  /** Backfill only accounting metadata and replace the two affected checks. */
  async up(runner: QueryRunner): Promise<void> {
    await runner.addColumn(
      "attachments",
      new TableColumn({ name: "encode_png", type: "boolean", default: false }),
    );
    await runner.addColumn(
      "attachments",
      new TableColumn({
        name: "input_size",
        type: "integer",
        isNullable: true,
      }),
    );
    await runner.query("UPDATE attachments SET input_size = size");
    await runner.changeColumn(
      "attachments",
      "input_size",
      new TableColumn({
        name: "input_size",
        type: "integer",
        isNullable: false,
      }),
    );
    await runner.dropCheckConstraint("attachments", "attachments_size_check");
    await runner.dropCheckConstraint("attachments", "attachments_status_check");
    await runner.createCheckConstraint(
      "attachments",
      new TableCheck({
        name: "attachments_size_check",
        expression:
          "size BETWEEN 0 AND 26214400 AND input_size BETWEEN 0 AND 26214400 AND received BETWEEN 0 AND input_size",
      }),
    );
    await runner.createCheckConstraint(
      "attachments",
      new TableCheck({
        name: "attachments_status_check",
        expression:
          "(status = 'uploading' AND message_id IS NULL) OR (status = 'ready' AND received = input_size AND kind IS NOT NULL AND media_type IS NOT NULL)",
      }),
    );
  }

  /** Restore the old progress invariant without touching stored bytes or their actual size. */
  async down(runner: QueryRunner): Promise<void> {
    const unfinished = (await runner.query(
      "SELECT id FROM attachments WHERE status = 'uploading' AND size <> input_size LIMIT 1",
    )) as unknown[];
    if (unfinished.length)
      throw new Error(
        "Finish or cancel prepared uploads before reverting attachment accounting",
      );
    await runner.dropCheckConstraint("attachments", "attachments_size_check");
    await runner.dropCheckConstraint("attachments", "attachments_status_check");
    await runner.query(
      "UPDATE attachments SET received = LEAST(received, size)",
    );
    await runner.dropColumn("attachments", "input_size");
    await runner.dropColumn("attachments", "encode_png");
    await runner.createCheckConstraint(
      "attachments",
      new TableCheck({
        name: "attachments_size_check",
        expression:
          "size BETWEEN 0 AND 26214400 AND received BETWEEN 0 AND size",
      }),
    );
    await runner.createCheckConstraint(
      "attachments",
      new TableCheck({
        name: "attachments_status_check",
        expression:
          "(status = 'uploading' AND message_id IS NULL) OR (status = 'ready' AND received = size AND kind IS NOT NULL AND media_type IS NOT NULL)",
      }),
    );
  }
}
