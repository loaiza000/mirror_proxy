import mongoose, { Schema, Document } from 'mongoose';
import { logger } from '../observability';
import { config } from '../config';
import { ComparisonResult, Difference, ComparisonSummary } from '../comparator';

export interface ComparisonResultDocument extends Omit<ComparisonResult, 'timestamp'>, Document {
  timestamp: Date;
}

const DifferenceSchema = new Schema<Difference>({
  type: { type: String, required: true, enum: ['status', 'header', 'body', 'latency'] },
  path: { type: String },
  expected: { type: Schema.Types.Mixed },
  actual: { type: Schema.Types.Mixed },
  severity: { type: String, required: true, enum: ['critical', 'major', 'minor'] },
});

const SummarySchema = new Schema<ComparisonSummary>({
  identical: { type: Boolean, required: true },
  totalDifferences: { type: Number, required: true },
  criticalDifferences: { type: Number, required: true },
  majorDifferences: { type: Number, required: true },
  minorDifferences: { type: Number, required: true },
  latencyDifference: { type: Number },
  latencyDifferencePercent: { type: Number },
});

const ComparisonResultSchema = new Schema<ComparisonResultDocument>({
  requestId: { type: String, required: true, index: true },
  target: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now, index: true },
  primaryResponse: { type: Schema.Types.Mixed, required: true },
  shadowResponse: { type: Schema.Types.Mixed, required: true },
  differences: [DifferenceSchema],
  summary: { type: SummarySchema, required: true },
});

// Compound indexes for better query performance
ComparisonResultSchema.index({ requestId: 1, target: 1 });
ComparisonResultSchema.index({ target: 1, timestamp: -1 });

const ComparisonResultModel = mongoose.model<ComparisonResultDocument>('ComparisonResult', ComparisonResultSchema);

export class MongoDatabase {
  private isConnected = false;

  async initialize(): Promise<void> {
    try {
      if (!config.database.host || !config.database.name) {
        logger.info('Database configuration not found, skipping database initialization');
        return;
      }

      let connectionString = `mongodb://${config.database.host}:${config.database.port}/${config.database.name}`;
      
      if (config.database.username && config.database.password) {
        connectionString = `mongodb://${config.database.username}:${config.database.password}@${config.database.host}:${config.database.port}/${config.database.name}`;
      }

      const options: mongoose.ConnectOptions = {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      };

      await mongoose.connect(connectionString, options);
      this.isConnected = true;
      
      logger.info({ database: config.database.name }, 'MongoDB connected successfully');
    } catch (error) {
      logger.error({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        host: config.database.host,
        port: config.database.port,
        database: config.database.name
      }, 'Failed to connect to MongoDB');
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.isConnected) {
      await mongoose.disconnect();
      this.isConnected = false;
      logger.info('MongoDB connection closed');
    }
  }

  async saveComparisonResult(result: ComparisonResult): Promise<void> {
    // Skip saving if database is not configured
    if (!this.isConnected) {
      logger.debug('MongoDB not connected, skipping comparison result save');
      return;
    }

    try {
      const document = new ComparisonResultModel({
        ...result,
        timestamp: new Date(result.timestamp),
      });

      await document.save();
      logger.debug({ requestId: result.requestId, target: result.target }, 'Comparison result saved to MongoDB');
    } catch (error) {
      logger.error({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId: result.requestId,
        target: result.target 
      }, 'Failed to save comparison result to MongoDB');
      throw error;
    }
  }

  async getComparisonResults(
    limit: number = 100, 
    offset: number = 0,
    target?: string
  ): Promise<ComparisonResult[]> {
    // Return empty results if database is not connected
    if (!this.isConnected) {
      logger.debug('MongoDB not connected, returning empty comparison results');
      return [];
    }

    try {
      const filter: Record<string, string> = {};
      if (target) {
        filter['target'] = target;
      }

      const documents = await ComparisonResultModel
        .find(filter)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean();

      return documents as unknown as ComparisonResult[];
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to get comparison results from MongoDB');
      throw error;
    }
  }

  async getComparisonStats(target?: string): Promise<any> {
    // Return empty stats if database is not connected
    if (!this.isConnected) {
      logger.debug('MongoDB not connected, returning empty comparison stats');
      return {
        total: 0,
        withDifferences: 0,
        critical: 0,
        warning: 0,
        info: 0,
      };
    }

    try {
      const matchFilter: Record<string, string> = {};
      if (target) {
        matchFilter['target'] = target;
      }

      const stats = await ComparisonResultModel.aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            identical: { $sum: { $cond: ['$summary.identical', 1, 0] } },
            different: { $sum: { $cond: ['$summary.identical', 0, 1] } },
            avgLatencyDiff: { $avg: '$summary.latencyDifference' },
            avgLatencyDiffPercent: { $avg: '$summary.latencyDifferencePercent' },
            avgDifferences: { $avg: '$summary.totalDifferences' },
            critical: { $sum: '$summary.criticalDifferences' },
            warning: { $sum: '$summary.majorDifferences' },
            info: { $sum: '$summary.minorDifferences' },
          }
        }
      ]);

      const result = stats[0] || {
        total: 0,
        identical: 0,
        different: 0,
        avgLatencyDiff: 0,
        avgLatencyDiffPercent: 0,
        avgDifferences: 0,
        critical: 0,
        warning: 0,
        info: 0,
      };

      return {
        total: result.total,
        withDifferences: result.different,
        critical: result.critical,
        warning: result.warning,
        info: result.info,
        avgLatencyDifference: result.avgLatencyDiff,
        avgLatencyDifferencePercent: result.avgLatencyDiffPercent,
        avgDifferences: result.avgDifferences,
      };
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to get comparison stats from MongoDB');
      throw error;
    }
  }
}

// Export singleton instance
export const database = new MongoDatabase();
