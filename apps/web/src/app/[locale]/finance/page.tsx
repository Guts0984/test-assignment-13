import { Suspense } from 'react';
import { FinanceView } from '../../../views/finance/ui';

export default function Page() {
  return (
    <Suspense>
      <FinanceView />
    </Suspense>
  );
}
