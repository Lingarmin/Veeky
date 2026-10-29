"""Add a cross-installation admission ledger without modifying history."""

from alembic import op
import sqlalchemy as sa

revision = "0010_resource_admission"
down_revision = "0009_translation_ownership"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "quota_usage",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("subject", sa.String(64), nullable=False),
        sa.Column("installation_id", sa.String(36), nullable=False),
        sa.Column("resource_id", sa.String(36), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("amount >= 0", name="ck_quota_usage_amount"),
    )
    for name, columns in (
        ("kind_created", ["kind", "created_at"]),
        ("subject_created", ["subject", "created_at"]),
        ("resource", ["resource_id"]),
        ("installation_created", ["installation_id", "created_at"]),
    ):
        op.create_index(f"ix_quota_usage_{name}", "quota_usage", columns)


def downgrade():
    op.drop_table("quota_usage")
