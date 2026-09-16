import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The last number issued in each document series (see common/utils/sequence.util.ts).
 *
 * Declared here as well as created by the QaFixesSchema migration: environments
 * running with DB_SYNCHRONIZE=true drop anything the entities do not declare.
 */
@Entity('document_sequences')
export class DocumentSequence {
  @PrimaryColumn({ type: 'uuid', name: 'company_id', primaryKeyConstraintName: 'PK_document_sequences' })
  companyId!: string;

  @PrimaryColumn({ type: 'varchar', length: 16, name: 'doc_type', primaryKeyConstraintName: 'PK_document_sequences' })
  docType!: string;

  @PrimaryColumn({ type: 'int', primaryKeyConstraintName: 'PK_document_sequences' })
  year!: number;

  @Column({ type: 'int', name: 'last_value', default: 0 })
  lastValue!: number;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
