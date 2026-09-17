import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReportFileView } from './ReportView';
import { readEmbeddedReport } from './export';

/**
 * Entry of the standalone file (plan §19): the report JSON sits in the page,
 * nothing is fetched. The empty template says so instead of rendering nothing.
 */
const data = readEmbeddedReport(document);
const root = createRoot(document.getElementById('root')!);
root.render(
  data ? (
    <ReportFileView data={data} />
  ) : (
    <div className="rp">
      <div className="rp-page">
        <p className="label">Strata Tune report template: no report embedded.</p>
      </div>
    </div>
  )
);
