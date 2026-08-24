import { forwardRef } from 'react';
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile';
import { env } from '../../config/env';

export interface TurnstileWidgetProps {
  onSuccess: (token: string) => void;
  onError?: (error?: unknown) => void;
  onExpire?: () => void;
  className?: string;
}

export const TurnstileWidget = forwardRef<TurnstileInstance | undefined, TurnstileWidgetProps>(
  function TurnstileWidget({ onSuccess, onError, onExpire, className }, ref) {
    const siteKey = env.TURNSTILE_SITE_KEY;

    if (!siteKey) {
      return null;
    }

    return (
      <div className={`flex justify-center my-2 ${className ?? ''}`}>
        <Turnstile
          ref={ref as React.Ref<TurnstileInstance>}
          siteKey={siteKey}
          onSuccess={onSuccess}
          onError={onError}
          onExpire={onExpire}
          options={{
            theme: 'auto',
          }}
        />
      </div>
    );
  },
);
