"""Scope translation caches and bind exact pre-existing history without assigning authorship."""

import sqlalchemy as sa
from alembic import op


revision = "0009_translation_ownership"
down_revision = "0008_x_analysis_pipeline"
branch_labels = None
depends_on = None


# Freeze the previous result-reader's endpoint fingerprint here. Do not import
# application code into a migration, or reinterpret historic relay URLs as an
# official provider. This SQL also runs in an offline Alembic deployment script.
_BIND_HISTORY = r"""
WITH snapshots AS (
    SELECT j.id, j.content_id, j.source_language, j.target_language,
           j.transcript_version, j.llm_config->>'provider' AS provider,
           j.llm_config->>'model' AS model,
           rtrim(btrim(j.llm_config->>'api_url'), '/') AS url
    FROM analysis_jobs j
    WHERE (j.status = 'completed' AND EXISTS (
               SELECT 1 FROM analysis_results r WHERE r.job_id = j.id)
           OR j.status = 'failed' AND j.failure_code = 'translation_failed')
      AND json_typeof(j.llm_config->'provider') = 'string'
      AND json_typeof(j.llm_config->'model') = 'string'
      AND json_typeof(j.llm_config->'api_url') = 'string'
), identities AS (
    SELECT *, CASE WHEN url LIKE '%/chat/completions' THEN url
                   WHEN url LIKE '%/v1' THEN url || '/chat/completions'
                   ELSE url || '/v1/chat/completions' END AS endpoint
    FROM snapshots
    WHERE provider <> '' AND model <> ''
      AND url ~ '^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[^?#[:space:]]*)?$'
), matches AS (
    SELECT j.id AS job_id, t.id AS translation_id,
           count(*) OVER (PARTITION BY j.id) AS candidates
    FROM identities j
    JOIN transcript_tracks track ON track.content_id = j.content_id
        AND track.language_code = j.source_language
        AND track.transcript_version = j.transcript_version
    JOIN translations t ON t.track_id = track.id
        AND t.target_language = j.target_language
        AND t.transcript_version = j.transcript_version
        AND t.provider = j.provider
        AND t.provider_version = j.provider || '.' || j.model || '+url.' ||
            substr(encode(sha256(convert_to(j.endpoint, 'UTF8')), 'hex'), 1, 12)
    WHERE t.installation_id IS NULL
)
UPDATE analysis_jobs j SET legacy_translation_id = m.translation_id
FROM matches m WHERE j.id = m.job_id AND m.candidates = 1
"""


def upgrade():
    op.add_column("translations", sa.Column("installation_id", sa.String(36), nullable=True))
    op.create_foreign_key("fk_translations_installation", "translations", "installations",
                          ["installation_id"], ["id"], ondelete="CASCADE")
    op.create_index("ix_translations_installation_id", "translations", ["installation_id"])
    op.add_column("analysis_jobs", sa.Column("legacy_translation_id", sa.String(36), nullable=True))
    op.create_foreign_key("fk_jobs_legacy_translation", "analysis_jobs", "translations",
                          ["legacy_translation_id"], ["id"], ondelete="SET NULL")
    op.execute(_BIND_HISTORY)
    op.drop_constraint("uq_translation_cache_key", "translations", type_="unique")
    op.create_unique_constraint("uq_translation_cache_key", "translations", [
        "installation_id", "track_id", "target_language", "transcript_version", "provider", "provider_version",
    ])


def downgrade():
    # Never merge users' outputs or silently discard them to restore the old key.
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM translations WHERE installation_id IS NOT NULL) THEN
            RAISE EXCEPTION 'Cannot downgrade scoped translations; restore a pre-migration backup instead';
        END IF;
    END $$""")
    op.drop_constraint("uq_translation_cache_key", "translations", type_="unique")
    op.create_unique_constraint("uq_translation_cache_key", "translations", [
        "track_id", "target_language", "transcript_version", "provider", "provider_version",
    ])
    op.drop_constraint("fk_jobs_legacy_translation", "analysis_jobs", type_="foreignkey")
    op.drop_column("analysis_jobs", "legacy_translation_id")
    op.drop_index("ix_translations_installation_id", table_name="translations")
    op.drop_constraint("fk_translations_installation", "translations", type_="foreignkey")
    op.drop_column("translations", "installation_id")
