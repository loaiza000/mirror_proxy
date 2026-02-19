import { logger } from '../observability';
import { ShadowClient, ShadowRequest, ShadowResponse } from './client';

export interface DispatchResult {
  target: string;
  response: ShadowResponse;
}

export class ShadowDispatcher {
  private clients: Map<string, ShadowClient> = new Map();

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

  async dispatchToTargets(request: ShadowRequest, targets: string[]): Promise<DispatchResult[]> {
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

    try {
      const results = await Promise.allSettled(promises);
      
      return results
        .filter((result): result is PromiseFulfilledResult<DispatchResult> => 
          result.status === 'fulfilled'
        )
        .map(result => result.value);

    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Error in batch dispatch');
      return [];
    }
  }

  private async dispatchToTarget(client: ShadowClient, request: ShadowRequest): Promise<DispatchResult> {
    const target = client.getTarget();
    
    try {
      const response = await client.sendRequest(request);
      return { target, response };
    } catch (error) {
      logger.error(
        { 
          target, 
          error: error instanceof Error ? error.message : 'Unknown error' 
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
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  async dispatchToTargetAsync(request: ShadowRequest, target: string): Promise<void> {
    const client = this.clients.get(target);
    if (!client) {
      logger.warn({ target }, 'Shadow client not found for async dispatch');
      return;
    }

    setImmediate(async () => {
      try {
        await client.sendRequest(request);
        logger.debug({ target }, 'Async shadow dispatch completed');
      } catch (error) {
        logger.error(
          { 
            target, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          },
          'Async shadow dispatch failed'
        );
      }
    });
  }

  clearTargets(): void {
    this.clients.clear();
    logger.info('All shadow targets cleared');
  }
}
