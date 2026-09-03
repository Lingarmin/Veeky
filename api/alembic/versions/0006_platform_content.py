"""Add platform-neutral content identity while retaining legacy video keys.

Revision ID: 0006_platform_content
Revises: 0005_one_active_job
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0006_platform_content"
down_revision: str | None = "0005_one_active_job"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()

    op.alter_column(
        "videos",
        "video_id",
        type_=sa.String(length=100),
        existing_type=sa.String(length=11),
        existing_nullable=False,
    )
    op.alter_column(
        "transcript_tracks",
        "video_id",
        type_=sa.String(length=100),
        existing_type=sa.String(length=11),
        existing_nullable=False,
    )
    op.alter_column(
        "analysis_jobs",
        "video_id",
        type_=sa.String(length=100),
        existing_type=sa.String(length=11),
        existing_nullable=False,
    )
    op.add_column(
        "videos", sa.Column("content_id", sa.String(length=36), nullable=True)
    )
    op.add_column(
        "videos", sa.Column("platform", sa.String(length=20), nullable=True)
    )
    op.add_column(
        "videos",
        sa.Column("source_content_id", sa.String(length=100), nullable=True),
    )
    op.add_column("videos", sa.Column("media_index", sa.Integer(), nullable=True))

    for row in connection.execute(sa.text("SELECT video_id FROM videos")).mappings():
        connection.execute(
            sa.text(
                """
                UPDATE videos
                SET content_id = :content_id,
                    platform = 'youtube',
                    source_content_id = video_id,
                    media_index = 1
                WHERE video_id = :video_id
                """
            ),
            {"content_id": str(uuid.uuid4()), "video_id": row["video_id"]},
        )

    op.alter_column("videos", "content_id", existing_type=sa.String(36), nullable=False)
    op.alter_column("videos", "platform", existing_type=sa.String(20), nullable=False)
    op.alter_column(
        "videos", "source_content_id", existing_type=sa.String(100), nullable=False
    )
    op.alter_column("videos", "media_index", existing_type=sa.Integer(), nullable=False)
    op.create_unique_constraint("uq_videos_content_id", "videos", ["content_id"])
    op.create_unique_constraint(
        "uq_videos_platform_source_media",
        "videos",
        ["platform", "source_content_id", "media_index"],
    )

    op.add_column(
        "transcript_tracks",
        sa.Column("content_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "analysis_jobs",
        sa.Column("content_id", sa.String(length=36), nullable=True),
    )
    op.execute(
        """
        UPDATE transcript_tracks
        SET content_id = videos.content_id
        FROM videos
        WHERE transcript_tracks.video_id = videos.video_id
        """
    )
    op.execute(
        """
        UPDATE analysis_jobs
        SET content_id = videos.content_id
        FROM videos
        WHERE analysis_jobs.video_id = videos.video_id
        """
    )
    op.alter_column(
        "transcript_tracks",
        "content_id",
        existing_type=sa.String(36),
        nullable=False,
    )
    op.alter_column(
        "analysis_jobs",
        "content_id",
        existing_type=sa.String(36),
        nullable=False,
    )
    op.create_foreign_key(
        "fk_transcript_tracks_content_id_videos",
        "transcript_tracks",
        "videos",
        ["content_id"],
        ["content_id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_analysis_jobs_content_id_videos",
        "analysis_jobs",
        "videos",
        ["content_id"],
        ["content_id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_transcript_tracks_content_id", "transcript_tracks", ["content_id"]
    )
    op.create_index("ix_analysis_jobs_content_id", "analysis_jobs", ["content_id"])
    op.alter_column(
        "analysis_jobs",
        "cache_key",
        type_=sa.String(length=500),
        existing_type=sa.String(length=300),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM analysis_jobs
        WHERE content_id IN (
            SELECT content_id FROM videos WHERE platform = 'x'
        )
        """
    )
    op.execute(
        """
        DELETE FROM transcript_tracks
        WHERE content_id IN (
            SELECT content_id FROM videos WHERE platform = 'x'
        )
        """
    )
    op.execute("DELETE FROM videos WHERE platform = 'x'")

    op.drop_index("ix_analysis_jobs_content_id", table_name="analysis_jobs")
    op.drop_index("ix_transcript_tracks_content_id", table_name="transcript_tracks")
    op.drop_constraint(
        "fk_analysis_jobs_content_id_videos",
        "analysis_jobs",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_transcript_tracks_content_id_videos",
        "transcript_tracks",
        type_="foreignkey",
    )
    op.drop_column("analysis_jobs", "content_id")
    op.drop_column("transcript_tracks", "content_id")

    op.drop_constraint(
        "uq_videos_platform_source_media", "videos", type_="unique"
    )
    op.drop_constraint("uq_videos_content_id", "videos", type_="unique")
    op.drop_column("videos", "media_index")
    op.drop_column("videos", "source_content_id")
    op.drop_column("videos", "platform")
    op.drop_column("videos", "content_id")

    op.alter_column(
        "analysis_jobs",
        "cache_key",
        type_=sa.String(length=300),
        existing_type=sa.String(length=500),
        existing_nullable=False,
    )
    op.alter_column(
        "analysis_jobs",
        "video_id",
        type_=sa.String(length=11),
        existing_type=sa.String(length=100),
        existing_nullable=False,
    )
    op.alter_column(
        "transcript_tracks",
        "video_id",
        type_=sa.String(length=11),
        existing_type=sa.String(length=100),
        existing_nullable=False,
    )
    op.alter_column(
        "videos",
        "video_id",
        type_=sa.String(length=11),
        existing_type=sa.String(length=100),
        existing_nullable=False,
    )
