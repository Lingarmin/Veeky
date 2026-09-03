from dataclasses import dataclass
from typing import Literal


Platform = Literal["youtube", "x"]


@dataclass(frozen=True, slots=True)
class ContentRef:
    platform: Platform
    source_content_id: str
    media_index: int = 1

    @property
    def stable_key(self) -> str:
        return f"{self.platform}:{self.source_content_id}:{self.media_index}"
