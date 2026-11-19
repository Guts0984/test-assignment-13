import { LotView } from '../../../../views/lot/ui';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <LotView id={(await params).id} />;
}
