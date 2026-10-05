# scorefollow Library Documentation

Core utility modules for PDF score analysis, cursor following, and practice session management.

## Modules

### analysis-guard.ts

**Purpose**: Runtime validation of analysis service responses before rendering

**Key Functions**:
- `isValidAnalysisResult(r: unknown): boolean` - Validates analysis response structure
- `numOrNull(v: unknown): boolean` - Type guard for number|null values

**Why it exists**: Backend version drift or malformed responses can crash the entire PerformancePanel if invalid data reaches the rendering layer. This guard is the single checkpoint before analysis results enter local storage.

**Contract**:
```typescript
interface AnalysisResult {
  version: string;
  notes: Array<{
    id: string;
    measure: number;
    expectedSec: number | null;
    performedSec: number | null;
    pitchErrorCents: number | null;
    timingErrorMs: number | null;
    confidence: number;
    status: string;
  }>;
  limitations: string[];
  summary: {
    pitchScore: number | null;
    rhythmScore: number | null;
    timingOffsetMs: number | null;
    timingSpreadMs: number | null;
    noteCount: number;
    voicedNotes: number;
    timedNotes: number;
    confidence: string;
  };
}
```

---

### practice-sync.ts

**Purpose**: Unified clock for metronome, recorder, cursor, and analysis

**Key Types**:
- `PracticeSession` - Session state with timing anchors
- `TakeMeta` - Metadata for each recording take
- `PracticeState` - State machine: idle → arming → counting-in → recording → stopping

**Core Concept**:
```typescript
// Score time calculation:
scoreTimeSec = (performance.now() - firstBeatAt) / 1000 + scoreOffsetSec

// Where:
// - firstBeatAt = performance.now() timestamp of startMeasure beat 1
// - firstBeatAudioSec = (firstBeatAt - recordingStartedAt) / 1000 in saved Blob
```

**Constants**:
- `MAX_FIRST_BEAT_AUDIO_SEC = 20` - Maximum allowed pre-roll before first beat

**Usage**: Shared by MetroDock (metronome), recording logic, and cursor tracking to maintain synchronization across all practice features.

---

### synpdf-core.ts

**Purpose**: Type-safe facade over synpdf-legacy pixel analysis

**Derived from**: [Wim Vree's synpdf.js rev.194](https://wim.vree.org/js2/), GPL-2.0-or-later

**Key Exports**:
- Page-level analysis types and caching
- Clean Next.js-compatible interface over legacy mutable state
- `ALGO_VERSION` - Current algorithm version identifier
- Diagnostic getters: `lastBarDiagnostics()`, `lastSystemConfidence()`, etc.

**Architecture**: All mutable state lives in `synpdf-legacy.ts`; this module provides:
- TypeScript types
- Page-level caching
- Facade pattern for app/page.tsx imports

**Do not import synpdf-legacy directly** - use this module instead.

---

### synpdf-legacy.ts

**Purpose**: Core pixel-based score analysis (ported from synpdf.js rev.194)

**Derived from**: [Wim Vree's synpdf.js rev.194](https://wim.vree.org/js2/), GPL-2.0-or-later  
**License**: GPL-2.0-or-later (derivative work)

**Core Algorithm** (zero preprocessing, pure pixel analysis):
1. **Horizontal projection** → find staff lines → group into systems (`drawRes`, `countVsys`)
2. **Vertical dark spans** → detect bar lines (must penetrate full staff height without crossing staff lines)
3. **Stem filtering** → exclude vertical spans that cross staff lines

**Mutable State**: This module holds ALL mutable state for the analysis. Settings are controlled via setters:
- `setSkipn(n: number)` - Skip first N pages
- `setSysprf(pref: number)` - System detection preference
- `setHomrGate(gate: HomrGateFile)` - Apply HOMR gate vetoes

**Key Functions**:
- `countPix()` / `countPixFromBuffer()` - Main analysis entry points
- `deskewCanvasInPlace()` - Auto-straighten skewed scans
- `estimateSkewAngle()` - Detect page rotation

**Advanced Parameters**: Exposed through `legacyOpt` object, controlled from app/page.tsx advanced panel.

---

### synpdf-wijzer.ts

**Purpose**: Cursor following (score position tracking during playback)

**Derived from**: Wim Vree's synpdf.js rev.194 Wijzer class, GPL-2.0-or-later

**Key Types**:
- `MeasureRect` - Bounding box for each measure
- `TimeEntry` - Time → measure mapping
- `CursorRect` - Current cursor position with measure number

**Key Functions**:
- `buildMeasures(a: PageAnalysis): MeasureRect[]` - Convert page analysis to measure rectangles
- `buildTimeMap(measures: MeasureRect[], bpm: number, ...): TimeEntry[]` - Build time → measure index mapping
- `getCurrentRect(timeMap: TimeEntry[], currentTime: number): CursorRect | null` - Get cursor position at given time

**Architecture**: Pure geometric/time calculations only. Original relied on jQuery DOM and media player; this version:
- Provides only mapping functions
- React overlay handles rendering
- Clock driven by page.tsx rAF loop or media element

**Constant**:
- `TOFF = 0.01` - Time offset for cursor positioning

---

## Design Principles

1. **Separation of Concerns**:
   - `synpdf-legacy.ts` = mutable algorithm state
   - `synpdf-core.ts` = type-safe facade
   - `synpdf-wijzer.ts` = pure cursor geometry
   - `practice-sync.ts` = timing coordination
   - `analysis-guard.ts` = data validation

2. **Type Safety**: All public interfaces use explicit TypeScript types

3. **Licensing**: GPL-2.0-or-later components clearly marked and attributed

4. **State Management**: Mutable state isolated to specific modules (synpdf-legacy)

5. **Facade Pattern**: app/page.tsx imports only through facades, never directly from legacy modules

## Usage Guidelines

### For Score Analysis
```typescript
import { analyzePage, getSpatium, ALGO_VERSION } from './lib/synpdf-core';
// Never import from synpdf-legacy directly
```

### For Cursor Tracking
```typescript
import { buildMeasures, buildTimeMap, getCurrentRect } from './lib/synpdf-wijzer';
```

### For Practice Sessions
```typescript
import { PracticeSession, TakeMeta } from './lib/practice-sync';
```

### For Analysis Validation
```typescript
import { isValidAnalysisResult } from './lib/analysis-guard';
if (!isValidAnalysisResult(response)) {
  // Handle invalid response
}
```

## Testing

Currently no automated tests for lib modules. Integration testing happens through:
- Manual PDF upload and analysis
- Recording and cursor tracking validation
- Analysis result rendering in PerformancePanel

## Future Improvements

1. Add unit tests for core functions
2. Extract shared types to a separate types.ts
3. Add JSDoc comments to all public functions
4. Consider moving to a monorepo structure
5. Document performance characteristics (memory, CPU)

## License

Modules derived from Wim Vree's synpdf.js (synpdf-legacy, synpdf-core, synpdf-wijzer) are licensed under GPL-2.0-or-later.

Other modules (analysis-guard, practice-sync) follow the project's main license.
