import { Pool } from "./common.mjs";

export const sourceAdmissionSubject = "synthetic:source-admission";

// Install the capability only around tests against an isolated synthetic DB.
export async function withSourceAdmissionRole(connection, run) {
  const target = new URL(connection);
  if (process.env.DATA_MODE !== "synthetic" || process.env.NODE_ENV === "production" ||
      !["127.0.0.1", "localhost"].includes(target.hostname) || !/^\/pdaa_test_[0-9]+$/.test(target.pathname)) {
    throw new Error("Source admission fixture requires an isolated synthetic database");
  }
  const pool = new Pool({ connectionString: connection });
  const fn = "public.admit_source_observation(uuid,uuid,uuid,uuid,integer,text,uuid)";
  try {
    // CREATE ROLE fails if an existing role has this name. Only unwind a role
    // installed successfully by this fixture.
    await pool.query(`BEGIN;
      CREATE ROLE pdaa_source_acceptance NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO pdaa_source_acceptance;
      GRANT EXECUTE ON FUNCTION ${fn} TO pdaa_source_acceptance;
      COMMIT`);
    try {
      return await run();
    } finally {
      await pool.query(`BEGIN;
        REVOKE ALL ON FUNCTION ${fn} FROM pdaa_source_acceptance;
        REVOKE USAGE ON SCHEMA public FROM pdaa_source_acceptance;
        DROP ROLE pdaa_source_acceptance;
        COMMIT`);
    }
  } finally {
    await pool.end();
  }
}
