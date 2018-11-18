import { start } from '../src/index';
import spectrum from 'csv-spectrum';

describe('csv-fns', () => {
  it('should parse spectrum csvs', () => {
    spectrum((_, data) => {
      for (const pair of data) {
        const csv = pair.csv.toString('utf8');
        const json = JSON.parse(pair.json.toString('utf8'));
        // all files have headers and expect blank lines to be skipped
        const result = start(csv, { header: true, skipEmptyLines: 'greedy' });
        expect(result.data).toEqual(json);
      }
    });
  });
});
