import { Injectable } from '@nestjs/common';

import { MVP_TIMEZONE_NAME, type MvpTimezone } from './app-settings.types';

export interface OperationalTimeContext {
  occurredAt: Date;
  storeLocalDatetime: string;
  businessDate: string;
  timezoneName: MvpTimezone;
}

@Injectable()
export class OperationalTimeService {
  private readonly formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone: MVP_TIMEZONE_NAME,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });

  resolve(occurredAt: Date): OperationalTimeContext {
    const epochMilliseconds = occurredAt.getTime();
    if (!Number.isFinite(epochMilliseconds)) {
      throw new TypeError('Operational time requires a valid UTC instant.');
    }

    const parts = this.formatter.formatToParts(occurredAt);
    const year = this.requiredPart(parts, 'year');
    const month = this.requiredPart(parts, 'month');
    const day = this.requiredPart(parts, 'day');
    const hour = this.requiredPart(parts, 'hour');
    const minute = this.requiredPart(parts, 'minute');
    const second = this.requiredPart(parts, 'second');
    const fractionalSecond = this.requiredPart(parts, 'fractionalSecond');
    const offset = this.parseOffset(this.requiredPart(parts, 'timeZoneName'));
    const businessDate = `${year}-${month}-${day}`;

    return {
      occurredAt: new Date(epochMilliseconds),
      storeLocalDatetime:
        `${businessDate}T${hour}:${minute}:${second}.${fractionalSecond}` +
        `${offset}[${MVP_TIMEZONE_NAME}]`,
      businessDate,
      timezoneName: MVP_TIMEZONE_NAME,
    };
  }

  private requiredPart(
    parts: Intl.DateTimeFormatPart[],
    type: Intl.DateTimeFormatPartTypes,
  ): string {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new Error('The runtime timezone engine returned an incomplete local datetime.');
    }
    return value;
  }

  private parseOffset(value: string): string {
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value);
    if (!match) {
      throw new Error('The runtime timezone engine returned an unsupported UTC offset.');
    }
    const [, sign, hours, minutes] = match;
    if (!sign || !hours || !minutes) {
      throw new Error('The runtime timezone engine returned an incomplete UTC offset.');
    }
    return `${sign}${hours}:${minutes}`;
  }
}
