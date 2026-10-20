import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRunSummaryRecorder } from '../../scripts/review/run-summary.js';

// Seam under test (ticket #40): dual-review completed-stage tracking and
// notification-first terminal comments.
//
// Regression 1: PR #39 run 34691443905 executed both reviewers to PASS on one
// exact HEAD, yet the durable status rendered only
// `Completed: Standards review, gates, exact-HEAD CI` — Spec review was
// omitted because the initial sequential reviewers ran under a single
// `Standards review` stage.
// This covers local review-cycle stage recording; hosted terminal notifications
// are no longer part of the execution contract.

function readReviewCycleSource(): string {
  return readFileSync('scripts/review-cycle.ts', 'utf8');
}

describe('dual-review completed stages (ticket #40)', () => {
  it('records both Standards and Spec review as completed when both exact-HEAD markers exist', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });
    recorder.setReviewedHead('a'.repeat(40));

    recorder.setStage('Standards review');
    // Both reviewers ran sequentially; exact-HEAD markers for both axes are
    // present, so both stages count as completed without concurrent workers.
    recorder.markCompleted('Standards review');
    recorder.markCompleted('Spec review');

    recorder.setStage('gates');
    recorder.setStage('exact-HEAD CI');
    recorder.setStage('final acceptance-ready');
    const summary = recorder.finish('READY', 'ready for final acceptance');

    expect(summary.completedStages).toContain('Standards review');
    expect(summary.completedStages).toContain('Spec review');
  });

  it('does not represent a missing axis as completed', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });
    recorder.setReviewedHead('b'.repeat(40));

    recorder.setStage('Standards review');
    recorder.markCompleted('Standards review');

    recorder.setStage('gates');
    const summary = recorder.finish('BLOCKED', 'missing current-HEAD reports for: spec');

    expect(summary.completedStages).toContain('Standards review');
    expect(summary.completedStages).not.toContain('Spec review');
  });

  it('keeps sequential reviewer execution independent in review-cycle', () => {
    const source = readReviewCycleSource();

    // Sequential execution under the shared profile: both axes still run
    // independently via the sequential scheduler, never concurrently.
    expect(source).toMatch(/runReviewAxesSequentially/);
    expect(source).not.toMatch(/Promise\.all/);
    // Completion is derived from exact-HEAD markers, never inferred.
    expect(source).toMatch(/markCompleted\(['"]Standards review['"]\)/);
    expect(source).toMatch(/markCompleted\(['"]Spec review['"]\)/);
  });
});
