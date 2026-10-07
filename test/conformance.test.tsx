import { runConformanceTests } from '@owload/editor-sdk/testing';
import { extension } from '../src/extension';
import { annexB, buildAvi, pps, slice, sps } from './builders';

const sample = buildAvi({
  frames: [annexB(sps(), pps(), slice({ idr: true, poc: 0 })), annexB(slice({ poc: 2 })), annexB(slice({ poc: 4 }))],
});

runConformanceTests(extension, {
  sample,
  // Ready once the viewer has stopped preparing the video (it shows the video, or why there is none).
  ready: (container) => !!container.querySelector('.av') && !container.querySelector('[role="status"]'),
});
