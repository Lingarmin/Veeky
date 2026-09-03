"""Add installation-owned resumable media upload sessions.

Revision ID: 0007_media_upload_sessions
Revises: 0006_platform_content
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0007_media_upload_sessions"
down_revision: str | None = "0006_platform_content"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "media_upload_sessions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("installation_id", sa.String(length=36), nullable=False),
        sa.Column("content_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("expected_bytes", sa.BigInteger(), nullable=False),
        sa.Column("received_bytes", sa.BigInteger(), nullable=False),
        sa.Column("media_kind", sa.String(length=10), nullable=False),
        sa.Column("part_count", sa.Integer(), nullable=False),
        sa.Column("part_size_bytes", sa.Integer(), nullable=False),
        sa.Column("uploaded_parts", sa.JSON(), nullable=False),
        sa.Column("hls_manifest", sa.JSON(), nullable=True),
        sa.Column("directory_key", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('created', 'uploading', 'complete', 'consumed', "
            "'expired', 'failed')",
            name="ck_media_upload_session_status",
        ),
        sa.CheckConstraint(
            "media_kind IN ('mp4', 'hls')",
            name="ck_media_upload_session_kind",
        ),
        sa.CheckConstraint(
            "expected_bytes > 0", name="ck_media_upload_session_expected_bytes"
        ),
        sa.CheckConstraint(
            "received_bytes >= 0 AND received_bytes <= expected_bytes",
            name="ck_media_upload_session_received_bytes",
        ),
        sa.CheckConstraint(
            "part_count > 0", name="ck_media_upload_session_part_count"
        ),
        sa.CheckConstraint(
            "part_size_bytes > 0", name="ck_media_upload_session_part_size_bytes"
        ),
        sa.ForeignKeyConstraint(
            ["installation_id"],
            ["installations.id"],
            name="fk_media_upload_sessions_installation_id_installations",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["content_id"],
            ["videos.content_id"],
            name="fk_media_upload_sessions_content_id_videos",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "directory_key", name="uq_media_upload_sessions_directory_key"
        ),
    )
    op.create_index(
        "ix_media_upload_sessions_owner_status",
        "media_upload_sessions",
        ["installation_id", "status"],
    )
    op.create_index(
        "ix_media_upload_sessions_expires_at",
        "media_upload_sessions",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_media_upload_sessions_expires_at", table_name="media_upload_sessions"
    )
    op.drop_index(
        "ix_media_upload_sessions_owner_status", table_name="media_upload_sessions"
    )
    op.drop_table("media_upload_sessions")
