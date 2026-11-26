import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DemoRequest } from './demo-request.entity';

/** An internal note on a demo request (super-admins only). */
@Entity('demo_request_notes')
@Index('idx_demo_request_notes_request', ['demoRequestId', 'createdAt'])
export class DemoRequestNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'demo_request_id' })
  demoRequestId!: string;

  @ManyToOne(() => DemoRequest, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'demo_request_id',
    foreignKeyConstraintName: 'fk_demo_request_notes_request',
  })
  demoRequest?: DemoRequest;

  @Column({ type: 'uuid', name: 'author_id', nullable: true })
  authorId!: string | null;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
