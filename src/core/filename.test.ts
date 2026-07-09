import { describe, expect, it } from 'vitest';
import { groupByFilename, parseFilename } from './filename';

describe('parseFilename', () => {
  it('parses the standard form', () => {
    expect(parseFilename('LOT2401_P001_R.png')).toEqual({
      lotId: 'LOT2401',
      panelCode: 'P001',
      pattern: 'R',
    });
  });

  it('allows underscores inside the lot id', () => {
    expect(parseFilename('LOT_2401_A_P001_W.jpg')).toEqual({
      lotId: 'LOT_2401_A',
      panelCode: 'P001',
      pattern: 'W',
    });
  });

  it('is case-insensitive on pattern and extension', () => {
    expect(parseFilename('LOT1_P1_b.JPEG')?.pattern).toBe('B');
  });

  it.each([
    ['no pattern token', 'LOT2401_P001.png'],
    ['unknown pattern', 'LOT2401_P001_X.png'],
    ['unsupported extension', 'LOT2401_P001_R.tiff'],
    ['no extension', 'LOT2401_P001_R'],
    ['too few segments', 'P001_R.png'],
  ])('rejects %s', (_label, name) => {
    expect(parseFilename(name)).toBeNull();
  });
});

describe('groupByFilename', () => {
  const nameOf = (s: string): string => s;

  it('groups four patterns into one panel', () => {
    const { panels, unparsed } = groupByFilename(
      ['L1_P1_R.png', 'L1_P1_G.png', 'L1_P1_B.png', 'L1_P1_W.png'],
      nameOf,
    );
    expect(unparsed).toHaveLength(0);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.missing).toHaveLength(0);
    expect(Object.keys(panels[0]!.images).sort()).toEqual(['B', 'G', 'R', 'W']);
  });

  it('keeps partial panels and reports what is missing', () => {
    const { panels } = groupByFilename(['L1_P1_R.png', 'L1_P1_W.png'], nameOf);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.missing).toEqual(['G', 'B']);
  });

  it('flags duplicate patterns instead of silently dropping one', () => {
    const { panels } = groupByFilename(['L1_P1_R.png', 'L1_P1_R.jpg'], nameOf);
    expect(panels[0]!.duplicates).toEqual(['R']);
  });

  it('separates panels and lots', () => {
    const { panels } = groupByFilename(['L1_P1_R.png', 'L1_P2_R.png', 'L2_P1_R.png'], nameOf);
    expect(panels).toHaveLength(3);
  });

  it('routes unparseable names to manual grouping', () => {
    const { panels, unparsed } = groupByFilename(['scan001.png', 'L1_P1_R.png'], nameOf);
    expect(panels).toHaveLength(1);
    expect(unparsed).toEqual(['scan001.png']);
  });
});
