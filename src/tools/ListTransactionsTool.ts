import { MCPTool, logger } from "mcp-framework";
import * as ynab from "ynab";
import { z } from "zod";

interface ListTransactionsInput {
  budgetId?: string;
  month?: string;
  sinceDate?: string;
  offset?: number;
  limit?: number;
}

interface TransactionOutput {
  id: string;
  date: string;
  account_name: string;
  payee_name?: string | null;
  category_name?: string | null;
  memo?: string | null;
  inflow: number;
  outflow: number;
  cleared: string;
  approved: boolean;
  transfer_transaction_id?: string | null;
}

interface RelatedTransactionGroup {
  primary: TransactionOutput;
  related: TransactionOutput;
}

class ListTransactionsTool extends MCPTool<ListTransactionsInput> {
  name = "list_transactions";
  description =
    "Lists transactions with optional filters for budget, month, or date range. Supports pagination and groups related transfer transactions.";

  schema = {
    budgetId: {
      type: z.string().optional(),
      description: "The ID of the budget (optional, defaults to YNAB_BUDGET_ID env variable)",
    },
    month: {
      type: z.string().optional(),
      description: "Filter by month in YYYY-MM format (e.g., 2024-03)",
    },
    sinceDate: {
      type: z.string().optional(),
      description: "Filter transactions since this date in YYYY-MM-DD format (defaults to 30 days ago if no month specified)",
    },
    offset: {
      type: z.number().optional(),
      description: "Pagination offset (default: 0)",
    },
    limit: {
      type: z.number().optional(),
      description: "Number of transactions per page (default: 100, max: 500)",
    },
  };

  private api: ynab.API;
  private budgetId: string;

  constructor() {
    super();
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  async execute(input: ListTransactionsInput) {
    const budgetId = input.budgetId || this.budgetId;

    if (!budgetId) {
      return "No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.";
    }

    const offset = input.offset || 0;
    const limit = Math.min(input.limit || 100, 500);

    try {
      logger.info(`Fetching transactions for budget ${budgetId}`);

      let allTransactions: ynab.TransactionDetail[] = [];

      if (input.month) {
        // Use month-specific endpoint
        const monthDate = input.month + "-01"; // Convert YYYY-MM to YYYY-MM-DD
        const response = await this.api.transactions.getTransactionsByMonth(
          budgetId,
          monthDate
        );
        allTransactions = response.data.transactions || [];
      } else {
        // Use general transactions endpoint with date filter
        let sinceDate = input.sinceDate;
        if (!sinceDate) {
          // Default to 30 days ago
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          sinceDate = thirtyDaysAgo.toISOString().split("T")[0];
        }

        const response = await this.api.transactions.getTransactions(
          budgetId,
          sinceDate
        );
        allTransactions = response.data.transactions;
      }

      // Filter out deleted transactions and sort by date (newest first)
      const activeTransactions = allTransactions
        .filter((t) => !t.deleted)
        .sort((a, b) => {
          const dateCompare = b.date.localeCompare(a.date);
          if (dateCompare !== 0) return dateCompare;
          // If same date, sort by creation (using ID as proxy)
          return b.id.localeCompare(a.id);
        });

      // Apply pagination
      const paginatedTransactions = activeTransactions.slice(
        offset,
        offset + limit
      );

      // Transform transactions
      const transformedTransactions = this.transformTransactions(paginatedTransactions);

      // Group related transfer transactions
      const relatedTransactions = this.groupRelatedTransactions(transformedTransactions);

      // Calculate summary for current page
      const summary = this.calculateSummary(transformedTransactions, allTransactions);

      // Pagination metadata
      const pagination = {
        offset,
        limit,
        total: activeTransactions.length,
        has_more: offset + limit < activeTransactions.length,
        next_offset:
          offset + limit < activeTransactions.length
            ? offset + limit
            : null,
      };

      return {
        transactions: transformedTransactions,
        related_transactions: relatedTransactions,
        pagination,
        summary,
      };
    } catch (error) {
      logger.error(`Error fetching transactions for budget ${budgetId}:`);
      logger.error(JSON.stringify(error, null, 2));
      return `Error fetching transactions: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`;
    }
  }

  private transformTransactions(
    transactions: ynab.TransactionDetail[]
  ): TransactionOutput[] {
    return transactions.map((transaction) => {
      const amount = transaction.amount / 1000; // Convert milliunits to actual currency
      
      return {
        id: transaction.id,
        date: transaction.date,
        account_name: transaction.account_name,
        payee_name: transaction.payee_name,
        category_name: transaction.category_name,
        memo: transaction.memo,
        inflow: amount > 0 ? amount : 0,
        outflow: amount < 0 ? Math.abs(amount) : 0,
        cleared: transaction.cleared,
        approved: transaction.approved,
        transfer_transaction_id: transaction.transfer_transaction_id,
      };
    });
  }

  private groupRelatedTransactions(
    transactions: TransactionOutput[]
  ): Record<string, RelatedTransactionGroup> {
    const groups: Record<string, RelatedTransactionGroup> = {};
    const processedIds = new Set<string>();

    for (const transaction of transactions) {
      if (
        transaction.transfer_transaction_id &&
        !processedIds.has(transaction.id)
      ) {
        // Find the related transaction
        const related = transactions.find(
          (t) => t.id === transaction.transfer_transaction_id
        );

        if (related) {
          processedIds.add(transaction.id);
          processedIds.add(related.id);

          // Determine which is primary (outflow) and which is related (inflow)
          const primary = transaction.outflow > 0 ? transaction : related;
          const relatedTx = transaction.outflow > 0 ? related : transaction;

          groups[transaction.transfer_transaction_id] = {
            primary,
            related: relatedTx,
          };
        }
      }
    }

    return groups;
  }

  private calculateSummary(
    paginatedTransactions: TransactionOutput[],
    allTransactions: ynab.TransactionDetail[]
  ) {
    const totalInflow = paginatedTransactions.reduce(
      (sum, t) => sum + t.inflow,
      0
    );
    const totalOutflow = paginatedTransactions.reduce(
      (sum, t) => sum + t.outflow,
      0
    );

    // Get date range from all transactions (not just paginated)
    const dates = allTransactions
      .filter((t) => !t.deleted)
      .map((t) => t.date)
      .sort();

    return {
      date_range: {
        from: dates[0] || null,
        to: dates[dates.length - 1] || null,
      },
      total_inflow: parseFloat(totalInflow.toFixed(2)),
      total_outflow: parseFloat(totalOutflow.toFixed(2)),
      net: parseFloat((totalInflow - totalOutflow).toFixed(2)),
    };
  }
}

export default ListTransactionsTool;