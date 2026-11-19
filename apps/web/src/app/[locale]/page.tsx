import { Suspense } from 'react';
import { SearchView } from '../../views/search/ui';

export default function Page() {
  return (
    <Suspense>
      <SearchView />
    </Suspense>
  );
}
