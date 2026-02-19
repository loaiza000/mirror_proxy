import { logger } from '../observability';
import { ShadowClient, ShadowRequest, ShadowResponse } from './client';
import { toErrorMessage } from '../middleware';

export interface DispatchResult {
  target: string;
  response: ShadowResponse;
}

export class ShadowDispatcher {
  private readonly clients: Map<string, ShadowClient> = new Map();

  addTarget(target: string): void {
    if (!this.clients.has(target)) {
      this.clients.set(target, new ShadowClient(target));
      logger.info({ target }, 'Shadow target added');
    }
  }

  removeTarget(target: string): void {
    if (this.clients.delete(target)) {
      logger.info({ target }, 'Shadow target removed');
    }
  }

  getTargets(): string[] {
    return Array.from(this.clients.keys());
  }

  async dispatchToTargets(
    request: ShadowRequest,
    targets: string[]
  ): Promise<DispatchResult[]> {
    const promises: Promise<DispatchResult>[] = [];

    for (const target of targets) {
      const client = this.clients.get(target);
      if (client) {
        promises.push(this.dispatchToTarget(client, request));
      } else {
        logger.warn({ target }, 'Shadow client not found for target');
      }
    }

    if (promises.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(promises);

    const fulfilled: DispatchResult[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        fulfilled.push(result.value);
      } else {
        logger.error(
          { error: toErrorMessage(result.reason) },
          'Unexpected error in shadow dispatch settlement'
        );
      }
    }

    return fulfilled;
  }

  private async dispatchToTarget(
    client: ShadowClient,
    request: ShadowRequest
  ): Promise<DispatchResult> {
    const target = client.getTarget();

    try {
      const response = await client.sendRequest(request);
      return { target, response };
    } catch (error) {
      logger.error(
        {
          target,
          error: toErrorMessage(error),
        },
        'Failed to dispatch to shadow target'
      );

      return {
        target,
        response: {
          status: 0,
          headers: {},
          body: null,
          duration: 0,
          error: toErrorMessage(error),
        },
      };
    }
  }

  clearTargets(): void {
    this.clients.clear();
    logger.info('All shadow targets cleared');
  }
}
