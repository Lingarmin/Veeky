"""Add installation ownership and temporary LLM credentials.

Revision ID: 0004_installation_security
Revises: 0003_llm_config
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0004_installation_security"
down_revision: str | None = "0003_llm_config"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


LEGACY_INSTALLATION_ID = "00000000-0000-4000-8000-000000000000"
LEGACY_TOKEN_HASH = "0" * 64


def upgrade() -> None:
    op.create_table(
        "installations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "length(token_hash) = 64", name="ck_installation_token_hash_length"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.execute(
        sa.text(
            "INSERT INTO installations (id, token_hash) "
            "VALUES (:id, :token_hash)"
        ).bindparams(id=LEGACY_INSTALLATION_ID, token_hash=LEGACY_TOKEN_HASH)
    )

    op.add_column(
        "analysis_jobs",
        sa.Column("installation_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "analysis_jobs",
        sa.Column("llm_credential_ciphertext", sa.Text(), nullable=True),
    )
    op.add_column(
        "analysis_jobs",
        sa.Column(
            "llm_credential_expires_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.execute(
        sa.text(
            "UPDATE analysis_jobs SET installation_id = :installation_id "
            "WHERE installation_id IS NULL"
        ).bindparams(installation_id=LEGACY_INSTALLATION_ID)
    )

    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            "UPDATE analysis_jobs "
            "SET llm_config = (llm_config::jsonb - 'api_key')::json "
            "WHERE llm_config IS NOT NULL"
        )

    op.alter_column("analysis_jobs", "installation_id", nullable=False)
    op.create_foreign_key(
        "fk_analysis_jobs_installation_id_installations",
        "analysis_jobs",
        "installations",
        ["installation_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_analysis_jobs_installation_id",
        "analysis_jobs",
        ["installation_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_analysis_jobs_installation_id", table_name="analysis_jobs")
    op.drop_constraint(
        "fk_analysis_jobs_installation_id_installations",
        "analysis_jobs",
        type_="foreignkey",
    )
    op.alter_column("analysis_jobs", "installation_id", nullable=True)
    op.drop_column("analysis_jobs", "llm_credential_expires_at")
    op.drop_column("analysis_jobs", "llm_credential_ciphertext")
    op.drop_column("analysis_jobs", "installation_id")
    op.drop_table("installations")
