"""Store the LLM configuration snapshot used by each analysis job.

Revision ID: 0003_llm_config
Revises: 0002_cache_versions
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0003_llm_config"
down_revision: str | None = "0002_cache_versions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("analysis_jobs", sa.Column("llm_config", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("analysis_jobs", "llm_config")
