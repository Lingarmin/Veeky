"""Include the translation provider in its cache key.

Revision ID: 0002_cache_versions
Revises: 0001_initial
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0002_cache_versions"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "analysis_jobs",
        sa.Column("transcript_version", sa.String(length=100), nullable=True),
    )
    op.execute(
        "UPDATE analysis_jobs "
        "SET transcript_version = split_part(cache_key, ':', 4)"
    )
    op.alter_column("analysis_jobs", "transcript_version", nullable=False)
    op.drop_constraint(
        "uq_translation_cache_key",
        "translations",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_translation_cache_key",
        "translations",
        [
            "track_id",
            "target_language",
            "transcript_version",
            "provider",
            "provider_version",
        ],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_translation_cache_key",
        "translations",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_translation_cache_key",
        "translations",
        [
            "track_id",
            "target_language",
            "transcript_version",
            "provider_version",
        ],
    )
    op.drop_column("analysis_jobs", "transcript_version")
