'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { parseFavorites } from '../../entities/favorite/model';
import {
  getMeControllerFavoritesQueryKey,
  tradingControllerFavorite,
  tradingControllerUnfavorite,
  useMeControllerFavorites,
} from '../../shared/api/generated/client';
import { useErrorText } from '../../shared/lib/errors';

/** Heart on the lot page: adds the lot to / removes it from the user's favourites. */
export const FavoriteToggle = ({ lotId }: { lotId: string }) => {
  const t = useTranslations('lot');
  const qc = useQueryClient();
  const errorText = useErrorText();
  const favorites = useMeControllerFavorites({ query: { retry: false } });
  const isFavorite = parseFavorites(favorites.data).some((f) => f.id === lotId);
  const toggle = useMutation({
    mutationFn: () =>
      isFavorite ? tradingControllerUnfavorite(lotId) : tradingControllerFavorite(lotId),
    onSuccess: () => qc.invalidateQueries({ queryKey: getMeControllerFavoritesQueryKey() }),
  });
  return (
    <div>
      <button
        type="button"
        aria-pressed={isFavorite}
        disabled={toggle.isPending || favorites.isLoading}
        onClick={() => toggle.mutate()}
        className="rounded border px-3 py-1 disabled:opacity-50"
      >
        <span aria-hidden="true">{isFavorite ? '♥' : '♡'}</span>{' '}
        {isFavorite ? t('unfavorite') : t('favorite')}
      </button>
      {toggle.error ? (
        <p role="alert" className="text-sm text-red-600">
          {errorText(toggle.error)}
        </p>
      ) : null}
    </div>
  );
};
