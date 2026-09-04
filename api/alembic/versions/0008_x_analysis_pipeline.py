"""Add X media analysis worker state and provenance.

Revision ID: 0008_x_analysis_pipeline
Revises: 0007_media_upload_sessions
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0008_x_analysis_pipeline"
down_revision: str | None = "0007_media_upload_sessions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_ACTIVE_STATUS_SQL = (
    "status IN ('queued', 'waiting_for_media', 'downloading_media', "
    "'extracting_audio', 'transcribing', 'fetching_transcript', "
    "'translating', 'analyzing')"
)
_ALL_STATUS_SQL = (
    "status IN ('queued', 'waiting_for_media', 'downloading_media', "
    "'extracting_audio', 'transcribing', 'fetching_transcript', "
    "'translating', 'analyzing', 'completed', 'failed')"
)


def upgrade() -> None:
    op.add_column(
        "transcript_tracks",
        sa.Column(
            "transcript_source",
            sa.String(length=40),
            nullable=False,
            server_default="youtube_caption",
        ),
    )
    op.add_column(
        "transcript_tracks",
        sa.Column("asr_model", sa.String(length=80), nullable=True),
    )
    op.add_column(
        "analysis_jobs",
        sa.Column("media_url_ciphertext", sa.Text(), nullable=True),
    )
    op.add_column(
        "analysis_jobs",
        sa.Column("media_session_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "analysis_jobs",
        sa.Column("lease_token", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "analysis_jobs",
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "analysis_jobs",
        sa.Column("force_run", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_foreign_key(
        "fk_analysis_jobs_media_session_id_media_upload_sessions",
        "analysis_jobs",
        "media_upload_sessions",
        ["media_session_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.drop_index(
        "uq_analysis_jobs_one_active_per_installation",
        table_name="analysis_jobs",
    )
    op.drop_constraint("ck_analysis_job_status", "analysis_jobs", type_="check")
    op.create_check_constraint(
        "ck_analysis_job_status",
        "analysis_jobs",
        _ALL_STATUS_SQL,
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
    op.execute(
        sa.text(
            """
            UPDATE analysis_jobs
            SET status = 'failed',
                failure_code = 'analysis_interrupted',
                completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
                llm_credential_ciphertext = NULL,
                llm_credential_expires_at = NULL,
                media_url_ciphertext = NULL
            WHERE status IN (
                'waiting_for_media', 'downloading_media',
                'extracting_audio', 'transcribing'
            )
            """
        )
    )
    op.drop_index(
        "uq_analysis_jobs_one_active_per_installation",
        table_name="analysis_jobs",
    )
    op.drop_constraint("ck_analysis_job_status", "analysis_jobs", type_="check")
    old_active = (
        "status IN ('queued', 'fetching_transcript', 'translating', 'analyzing')"
    )
    op.create_check_constraint(
        "ck_analysis_job_status",
        "analysis_jobs",
        "status IN ('queued', 'fetching_transcript', 'translating', "
        "'analyzing', 'completed', 'failed')",
    )
    op.create_index(
        "uq_analysis_jobs_one_active_per_installation",
        "analysis_jobs",
        ["installation_id"],
        unique=True,
        postgresql_where=sa.text(old_active),
        sqlite_where=sa.text(old_active),
    )
    op.drop_constraint(
        "fk_analysis_jobs_media_session_id_media_upload_sessions",
        "analysis_jobs",
        type_="foreignkey",
    )
    op.drop_column("analysis_jobs", "force_run")
    op.drop_column("analysis_jobs", "lease_expires_at")
    op.drop_column("analysis_jobs", "lease_token")
    op.drop_column("analysis_jobs", "media_session_id")
    op.drop_column("analysis_jobs", "media_url_ciphertext")
    op.drop_column("transcript_tracks", "asr_model")
    op.drop_column("transcript_tracks", "transcript_source")
