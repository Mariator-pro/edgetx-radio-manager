import { setShippedCatalog } from '../src/core/known.ts';

// Tests compare cards only with the versions they set up, not with the checksums shipped with the app.
setShippedCatalog({});
