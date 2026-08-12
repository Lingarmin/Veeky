"""Allow only one active analysis job per installation.

Revision ID: 0005_one_active_job
Revises: 0004_installation_security
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0005_one_active_job"
down_revision: str | None = "0004_installation_security"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_ACTIVE_STATUS_SQL = (
    "status IN ('queued', 'fetching_transcript', 'translating', 'analyzing')"
)


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            WITH ranked_active_jobs AS (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY installation_id
                           ORDER BY created_at DESC, id DESC
                       ) AS position
                FROM analysis_jobs
                WHERE status IN (
                    'queued', 'fetching_transcript', 'translating', 'analyzing'
                )
            )
            UPDATE analysis_jobs
            SET status = 'failed',
                failure_code = 'analysis_concurrency_limit',
                failure_detail = 'Superseded while enforcing one active job per installation',
                completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
                llm_credential_ciphertext = NULL,
                llm_credential_expires_at = NULL
            WHERE id IN (
                SELECT id FROM ranked_active_jobs WHERE position > 1
            )
            """
        )
    )
    op.create_index(
        "uq_analysis_jobs_one_active_per_installation",
        "analysis_jobs",
        ["installation_id"],
        unique=True,
        postgresql_where=sa.text(_ACTIVE_STATUS_SQL),
        sqlite_where=sa.text(_ACTIVE_STATUS_SQL),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_analysis_jobs_one_active_per_installation",
        table_name="analysis_jobs",
    )
