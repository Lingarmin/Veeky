from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    select,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def uuid_string() -> str:
    return str(uuid.uuid4())


def legacy_source_content_id(context: Any) -> str:
    return str(context.get_current_parameters()["video_id"])


class Base(DeclarativeBase):
    pass


class Installation(Base):
    __tablename__ = "installations"
    __table_args__ = (
        CheckConstraint("length(token_hash) = 64", name="ck_installation_token_hash_length"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_string)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    jobs: Mapped[list[AnalysisJob]] = relationship(back_populates="installation")


class Video(Base):
    __tablename__ = "videos"
    __table_args__ = (
        UniqueConstraint("content_id", name="uq_videos_content_id"),
        UniqueConstraint(
            "platform",
            "source_content_id",
            "media_index",
            name="uq_videos_platform_source_media",
        ),
    )

    video_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    content_id: Mapped[str] = mapped_column(String(36), default=uuid_string)
    platform: Mapped[str] = mapped_column(String(20), default="youtube")
    source_content_id: Mapped[str] = mapped_column(
        String(100), default=legacy_source_content_id
    )
    media_index: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(500))
    duration_ms: Mapped[int] = mapped_column(Integer)
    source_url: Mapped[str] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    tracks: Mapped[list[TranscriptTrack]] = relationship(
        back_populates="video",
        cascade="all, delete-orphan",
        foreign_keys="TranscriptTrack.video_id",
    )
    content_tracks: Mapped[list[TranscriptTrack]] = relationship(
        back_populates="content",
        foreign_keys="TranscriptTrack.content_id",
    )
    jobs: Mapped[list[AnalysisJob]] = relationship(
        back_populates="video", foreign_keys="AnalysisJob.video_id"
    )
    content_jobs: Mapped[list[AnalysisJob]] = relationship(
        back_populates="content", foreign_keys="AnalysisJob.content_id"
    )


def content_id_for_video(context: Any) -> str:
    video_id = context.get_current_parameters()["video_id"]
    return context.connection.execute(
        select(Video.content_id).where(Video.video_id == video_id)
    ).scalar_one()


class TranscriptTrack(Base):
    __tablename__ = "transcript_tracks"
    __table_args__ = (
        UniqueConstraint(
            "video_id",
            "language_code",
            "is_generated",
            "transcript_version",
            name="uq_transcript_track_version",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_string)
    video_id: Mapped[str] = mapped_column(
        ForeignKey("videos.video_id", ondelete="CASCADE"), index=True
    )
    content_id: Mapped[str] = mapped_column(
        ForeignKey("videos.content_id", ondelete="CASCADE"),
        index=True,
        default=content_id_for_video,
    )
    language_code: Mapped[str] = mapped_column(String(35))
    language_name: Mapped[str] = mapped_column(String(120))
    is_generated: Mapped[bool] = mapped_column(Boolean)
    is_translatable: Mapped[bool] = mapped_column(Boolean)
    transcript_version: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    video: Mapped[Video] = relationship(
        back_populates="tracks", foreign_keys=[video_id]
    )
    content: Mapped[Video] = relationship(
        back_populates="content_tracks", foreign_keys=[content_id]
    )
    segments: Mapped[list[TranscriptSegment]] = relationship(
        back_populates="track", cascade="all, delete-orphan"
    )
    translations: Mapped[list[Translation]] = relationship(
        back_populates="track", cascade="all, delete-orphan"
    )


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"
    __table_args__ = (
        UniqueConstraint("track_id", "sequence", name="uq_transcript_segment_sequence"),
        CheckConstraint("start_ms >= 0", name="ck_transcript_segment_start"),
        CheckConstraint("duration_ms > 0", name="ck_transcript_segment_duration"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_string)
    track_id: Mapped[str] = mapped_column(
        ForeignKey("transcript_tracks.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(Integer)
    duration_ms: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)

    track: Mapped[TranscriptTrack] = relationship(back_populates="segments")


class Translation(Base):
    __tablename__ = "translations"
    __table_args__ = (
        UniqueConstraint(
            "track_id",
            "target_language",
            "transcript_version",
            "provider",
            "provider_version",
            name="uq_translation_cache_key",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_string)
    track_id: Mapped[str] = mapped_column(
        ForeignKey("transcript_tracks.id", ondelete="CASCADE"), index=True
    )
    target_language: Mapped[str] = mapped_column(String(35))
    provider: Mapped[str] = mapped_column(String(80))
    provider_version: Mapped[str] = mapped_column(String(80))
    transcript_version: Mapped[str] = mapped_column(String(100))
    segments: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    track: Mapped[TranscriptTrack] = relationship(back_populates="translations")


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'fetching_transcript', 'translating', "
            "'analyzing', 'completed', 'failed')",
            name="ck_analysis_job_status",
        ),
        Index("ix_analysis_jobs_video_languages", "video_id", "source_language", "target_language"),
        Index(
            "uq_analysis_jobs_one_active_per_installation",
            "installation_id",
            unique=True,
            postgresql_where=text(
                "status IN ('queued', 'fetching_transcript', 'translating', 'analyzing')"
            ),
            sqlite_where=text(
                "status IN ('queued', 'fetching_transcript', 'translating', 'analyzing')"
            ),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_string)
    installation_id: Mapped[str] = mapped_column(
        ForeignKey("installations.id", ondelete="CASCADE"), index=True
    )
    video_id: Mapped[str] = mapped_column(
        ForeignKey("videos.video_id", ondelete="CASCADE"), index=True
    )
    content_id: Mapped[str] = mapped_column(
        ForeignKey("videos.content_id", ondelete="CASCADE"),
        index=True,
        default=content_id_for_video,
    )
    source_language: Mapped[str] = mapped_column(String(35))
    target_language: Mapped[str] = mapped_column(String(35))
    transcript_version: Mapped[str] = mapped_column(String(100))
    cache_key: Mapped[str] = mapped_column(String(500), unique=True)
    llm_config: Mapped[dict[str, str] | None] = mapped_column(JSON, nullable=True)
    llm_credential_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    llm_credential_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    status: Mapped[str] = mapped_column(String(40), default="queued")
    failure_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    failure_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    installation: Mapped[Installation] = relationship(back_populates="jobs")
    video: Mapped[Video] = relationship(
        back_populates="jobs", foreign_keys=[video_id]
    )
    content: Mapped[Video] = relationship(
        back_populates="content_jobs", foreign_keys=[content_id]
    )
    result: Mapped[AnalysisResult | None] = relationship(
        back_populates="job", cascade="all, delete-orphan", uselist=False
    )


class AnalysisResult(Base):
    __tablename__ = "analysis_results"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_string)
    job_id: Mapped[str] = mapped_column(
        ForeignKey("analysis_jobs.id", ondelete="CASCADE"), unique=True
    )
    one_line_summary: Mapped[str] = mapped_column(Text)
    summary_points: Mapped[list[str]] = mapped_column(JSON)
    chapters: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    highlights: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    model_name: Mapped[str] = mapped_column(String(120))
    model_version: Mapped[str] = mapped_column(String(120))
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    job: Mapped[AnalysisJob] = relationship(back_populates="result")
