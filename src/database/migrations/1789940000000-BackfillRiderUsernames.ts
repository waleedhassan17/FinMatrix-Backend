import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Name every rider who has no username.
 *
 * A rider signs in with a username and a password issued by the office, and
 * there is no self-service recovery. `users.username` was only ever written by
 * one branch of DeliveryPersonnelService.create — the one that makes a brand-new
 * user — so riders who arrived by self-signup with an invite code, by
 * companies.join, by the {userId} attach path, or from a seed were created
 * nameless. Those accounts cannot be signed into at all, and the office had
 * nothing to hand over: the rider page rendered an empty field with a working
 * Copy button.
 *
 * The rule is duplicated from src/modules/delivery-personnel/rider-username.ts
 * ON PURPOSE. A migration must not import application code, because that code
 * can change under it and silently rewrite what this migration did. The two are
 * kept in step by rider-username.spec.ts; if you change the rule there, change
 * it here and re-run that spec.
 *
 * Shape: `<lowercased invite code>.<first name>`, collisions resolved by walking
 * a numeric suffix. `users.username` is globally unique, so the suffix walk is a
 * loop rather than a window function — a batch-local ranking cannot see names
 * already held by rows outside the batch.
 *
 * Idempotent: the population is `username IS NULL`, so a second run does
 * nothing. Runs inside the release phase under `transaction: 'each'`, so it
 * names everyone or nobody.
 */
export class BackfillRiderUsernames1789940000000 implements MigrationInterface {
  name = 'BackfillRiderUsernames1789940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        r            RECORD;
        v_code       text;
        v_who        text;
        v_base       text;
        v_candidate  text;
        v_suffix     int;
        v_updated    int;
        v_named      int := 0;
      BEGIN
        FOR r IN
          SELECT u.id,
                 u.display_name,
                 u.email,
                 COALESCE(
                   (SELECT p.company_id FROM delivery_personnel_profiles p
                     WHERE p.user_id = u.id ORDER BY p.created_at LIMIT 1),
                   u.default_company_id,
                   (SELECT uc.company_id FROM user_companies uc
                     WHERE uc.user_id = u.id ORDER BY uc.joined_at LIMIT 1)
                 ) AS company_id
            FROM users u
           WHERE u.username IS NULL
             AND (
               u.role = 'delivery'
               OR EXISTS (SELECT 1 FROM delivery_personnel_profiles p WHERE p.user_id = u.id)
             )
        LOOP
          -- <code>.<who>, folded to the character set the username rule allows.
          v_code := NULLIF(regexp_replace(
            lower(COALESCE((SELECT c.invite_code FROM companies c WHERE c.id = r.company_id), '')),
            '[^a-z0-9]', '', 'g'), '');
          v_code := COALESCE(v_code, 'rider');

          v_who := NULLIF(regexp_replace(
            lower(split_part(COALESCE(r.display_name, ''), ' ', 1)),
            '[^a-z0-9]', '', 'g'), '');
          IF v_who IS NULL THEN
            v_who := NULLIF(regexp_replace(
              lower(split_part(COALESCE(r.email, ''), '@', 1)),
              '[^a-z0-9]', '', 'g'), '');
          END IF;
          v_who := COALESCE(v_who, 'rider');

          -- 58 leaves room for a numeric suffix inside varchar(64).
          v_base := left(v_code || '.' || v_who, 58);
          v_base := regexp_replace(v_base, '[._-]+$', '');
          WHILE length(v_base) < 3 LOOP
            v_base := v_base || '0';
          END LOOP;

          -- Walk suffixes until one lands. The UPDATE itself does the claiming,
          -- so a concurrent writer cannot hand us a name that is taken by the
          -- time we use it.
          v_suffix := 1;
          LOOP
            v_candidate := CASE WHEN v_suffix = 1 THEN v_base
                                ELSE v_base || v_suffix::text END;
            BEGIN
              UPDATE users
                 SET username = v_candidate
               WHERE id = r.id
                 AND username IS NULL
                 AND NOT EXISTS (SELECT 1 FROM users x WHERE x.username = v_candidate);
              GET DIAGNOSTICS v_updated = ROW_COUNT;
            EXCEPTION WHEN unique_violation THEN
              v_updated := 0;
            END;

            EXIT WHEN v_updated = 1;
            v_suffix := v_suffix + 1;
            IF v_suffix > 1000 THEN
              RAISE EXCEPTION 'Could not allocate a rider username from base %', v_base;
            END IF;
          END LOOP;

          v_named := v_named + 1;
          RAISE NOTICE '[backfill-rider-username] % -> %', r.id, v_candidate;

          -- Durable record: Heroku release logs expire, this does not.
          -- company_id is NOT NULL, so a rider with no resolvable company is
          -- still named above but not audited here.
          IF r.company_id IS NOT NULL THEN
            INSERT INTO operational_audit_events
              (company_id, actor_user_id, action, target_type, target_id, details)
            VALUES
              (r.company_id, NULL, 'personnel_username_backfilled',
               'delivery_personnel', r.id::text,
               jsonb_build_object('username', v_candidate,
                                  'source', 'migration/1789940000000'));
          END IF;
        END LOOP;

        RAISE NOTICE '[backfill-rider-username] % rider(s) named', v_named;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. By the time anyone rolls back, riders are signing in
    // with these usernames — nulling them would lock out the accounts this
    // migration exists to rescue, and there is no prior state worth restoring:
    // the column was empty. Reverting the deploy is safe; the change is additive.
  }
}
