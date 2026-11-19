'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { REALTIME_EVENTS } from '@auction/shared';
import {
  getMeControllerNotificationsQueryKey,
  getMeControllerWalletQueryKey,
  useMeControllerNotifications,
} from '../../shared/api/generated/client';
import { parseNotifications, type AppNotification } from './model';

/**
 * The signed-in user's notifications. While `enabled`, a socket listens for the server's private `notification`
 * event and refetches the list at once, so an outbid user sees it without reloading.
 */
export const useNotifications = (
  enabled: boolean,
): { items: AppNotification[]; unread: number; isLoading: boolean } => {
  const qc = useQueryClient();
  const list = useMeControllerNotifications({ query: { enabled, retry: false } });
  useEffect(() => {
    if (!enabled) return;
    const socket = io({ path: '/socket.io', transports: ['websocket'] });
    socket.on(REALTIME_EVENTS.notification, () => {
      void qc.invalidateQueries({ queryKey: getMeControllerNotificationsQueryKey() });
      void qc.invalidateQueries({ queryKey: getMeControllerWalletQueryKey() });
    });
    return () => {
      socket.close();
    };
  }, [enabled, qc]);
  const items = parseNotifications(list.data);
  return { items, unread: items.filter((n) => !n.read).length, isLoading: list.isLoading };
};
