import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('delivery_signatures')
@Index(['deliveryId'])
export class DeliverySignature {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'delivery_id' })
  deliveryId!: string;

  @Column({ type: 'text', name: 'image_url' })
  imageUrl!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'signer_name' })
  signerName!: string | null;

  @Column({ type: 'timestamptz', name: 'captured_at' })
  capturedAt!: Date;
}
