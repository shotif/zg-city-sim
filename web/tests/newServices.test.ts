import { describe, expect, it } from 'vitest';

import { type Edit, describeEdit, parseEdits, serializeEdits, withEdit } from '../src/edit/edits';
import { editCost } from '../src/grow/economy';
import {
  NEW_SERVICE,
  addDemand,
  builtServices,
  nextServiceName,
  serviceDemand,
} from '../src/grow/newServices';

describe('new services', () => {
  const school: Edit = {
    kind: 'service',
    service: 'school',
    name: 'New primary school 1',
    x: 10.4,
    z: -3.6,
  };

  it('are edits: kept, described, priced and taken back like others', () => {
    expect(describeEdit(school)).toBe('Primary school: New primary school 1');
    expect(parseEdits(serializeEdits([school]))).toEqual([{ ...school, x: 10, z: -4 }]);
    expect(
      parseEdits(
        '{"version":1,"edits":[{"kind":"service","service":"spa","name":"x","x":0,"z":0}]}',
      ),
    ).toEqual([]);
    expect(editCost(school)).toEqual({
      build: NEW_SERVICE.school.build,
      upkeep: NEW_SERVICE.school.upkeep,
      service: 0,
    });
    const second: Edit = { ...school, name: 'New primary school 2', x: 500 };
    expect(withEdit([school], second)).toEqual([school, second]);
    expect(nextServiceName('school', 'Primary school', [school, second])).toBe(
      'New primary school 3',
    );
    expect(nextServiceName('kindergarten', 'Kindergarten', [school])).toBe('New kindergarten 1');
  });

  it('take places within reach and draw trips as jobs on the street in front', () => {
    const fire: Edit = { kind: 'service', service: 'fire', name: 'New fire station 1', x: 0, z: 0 };
    const built = builtServices([school, fire, { kind: 'close' } as unknown as Edit], (x) =>
      x > 5 ? 7 : -1,
    );
    expect(built.map((s) => [s.kind, s.edge, s.places])).toEqual([
      ['school', 7, NEW_SERVICE.school.places],
      ['fire', -1, 0],
    ]);
    const jobs = serviceDemand(built);
    expect([...jobs]).toEqual([
      [7, { home: 0, work: NEW_SERVICE.school.staff + NEW_SERVICE.school.visits }],
    ]);
    const both = addDemand(
      jobs,
      new Map([
        [7, { home: 10, work: 1 }],
        [8, { home: 2, work: 0 }],
      ]),
    );
    expect(both.get(7)).toEqual({
      home: 10,
      work: NEW_SERVICE.school.staff + NEW_SERVICE.school.visits + 1,
    });
    expect(both.get(8)).toEqual({ home: 2, work: 0 });
    expect(addDemand(undefined, undefined).size).toBe(0);
  });
});
