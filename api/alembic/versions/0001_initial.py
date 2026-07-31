"""Create the initial video analysis schema.

Revision ID: 0001_initial
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "videos",
        sa.Column("video_id", sa.String(length=11), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("source_url", sa.String(length=1000), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("video_id"),
    )
    op.create_table(
        "transcript_tracks",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("video_id", sa.String(length=11), nullable=False),
        sa.Column("language_code", sa.String(length=35), nullable=False),
        sa.Column("language_name", sa.String(length=120), nullable=False),
        sa.Column("is_generated", sa.Boolean(), nullable=False),
        sa.Column("is_translatable", sa.Boolean(), nullable=False),
        sa.Column("transcript_version", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["video_id"], ["videos.video_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "video_id",
            "language_code",
            "is_generated",
            "transcript_version",
            name="uq_transcript_track_version",
        ),
    )
    op.create_index("ix_transcript_tracks_video_id", "transcript_tracks", ["video_id"])
    op.create_table(
        "transcript_segments",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("track_id", sa.String(length=36), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.CheckConstraint("duration_ms > 0", name="ck_transcript_segment_duration"),
        sa.CheckConstraint("start_ms >= 0", name="ck_transcript_segment_start"),
        sa.ForeignKeyConstraint(["track_id"], ["transcript_tracks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("track_id", "sequence", name="uq_transcript_segment_sequence"),
    )
    op.create_index("ix_transcript_segments_track_id", "transcript_segments", ["track_id"])
    op.create_table(
        "translations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("track_id", sa.String(length=36), nullable=False),
        sa.Column("target_language", sa.String(length=35), nullable=False),
        sa.Column("provider", sa.String(length=80), nullable=False),
        sa.Column("provider_version", sa.String(length=80), nullable=False),
        sa.Column("transcript_version", sa.String(length=100), nullable=False),
        sa.Column("segments", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["track_id"], ["transcript_tracks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "track_id",
            "target_language",
            "transcript_version",
            "provider_version",
            name="uq_translation_cache_key",
        ),
    )
    op.create_index("ix_translations_track_id", "translations", ["track_id"])
    op.create_table(
        "analysis_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("video_id", sa.String(length=11), nullable=False),
        sa.Column("source_language", sa.String(length=35), nullable=False),
        sa.Column("target_language", sa.String(length=35), nullable=False),
        sa.Column("cache_key", sa.String(length=300), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("failure_code", sa.String(length=80), nullable=True),
        sa.Column("failure_detail", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('queued', 'fetching_transcript', 'translating', "
            "'analyzing', 'completed', 'failed')",
            name="ck_analysis_job_status",
        ),
        sa.ForeignKeyConstraint(["video_id"], ["videos.video_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("cache_key"),
    )
    op.create_index("ix_analysis_jobs_video_id", "analysis_jobs", ["video_id"])
    op.create_index(
        "ix_analysis_jobs_video_languages",
        "analysis_jobs",
        ["video_id", "source_language", "target_language"],
    )
    op.create_table(
        "analysis_results",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("job_id", sa.String(length=36), nullable=False),
        sa.Column("one_line_summary", sa.Text(), nullable=False),
        sa.Column("summary_points", sa.JSON(), nullable=False),
        sa.Column("chapters", sa.JSON(), nullable=False),
        sa.Column("highlights", sa.JSON(), nullable=False),
        sa.Column("model_name", sa.String(length=120), nullable=False),
        sa.Column("model_version", sa.String(length=120), nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["analysis_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id"),
    )


def downgrade() -> None:
    op.drop_table("analysis_results")
    op.drop_index("ix_analysis_jobs_video_languages", table_name="analysis_jobs")
    op.drop_index("ix_analysis_jobs_video_id", table_name="analysis_jobs")
    op.drop_table("analysis_jobs")
    op.drop_index("ix_translations_track_id", table_name="translations")
    op.drop_table("translations")
    op.drop_index("ix_transcript_segments_track_id", table_name="transcript_segments")
    op.drop_table("transcript_segments")
    op.drop_index("ix_transcript_tracks_video_id", table_name="transcript_tracks")
    op.drop_table("transcript_tracks")
    op.drop_table("videos")
