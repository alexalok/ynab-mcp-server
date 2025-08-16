import { MCPTool, logger } from "mcp-framework";
import * as ynab from "ynab";
import { z } from "zod";
class ListTransactionsTool extends MCPTool {
    name = "list_transactions";
    description = "Lists transactions for a specific month. Supports pagination, groups related transfer transactions, and can filter to show only external payments (non-transfers).";
    schema = {
        budgetId: {
            type: z.string().optional(),
            description: "The ID of the budget (optional, defaults to YNAB_BUDGET_ID env variable)",
        },
        month: {
            type: z.string(),
            description: "Month to retrieve transactions for in YYYY-MM format (e.g., 2024-03)",
        },
        offset: {
            type: z.number().optional(),
            description: "Pagination offset (default: 0)",
        },
        limit: {
            type: z.number().optional(),
            description: "Number of transactions per page (default: 100, max: 500)",
        },
        paymentsOnly: {
            type: z.boolean().optional(),
            description: "If true, only show external payments (exclude transfers between your own accounts)",
        },
    };
    api;
    budgetId;
    constructor() {
        super();
        if (!process.env.YNAB_API_TOKEN) {
            throw new Error("YNAB_API_TOKEN environment variable is not set. Please set it to a valid YNAB API token.");
        }
        this.api = new ynab.API(process.env.YNAB_API_TOKEN);
        this.budgetId = process.env.YNAB_BUDGET_ID || "";
    }
    async execute(input) {
        const budgetId = input.budgetId || this.budgetId;
        if (!budgetId) {
            return "No budget ID provided. Please provide a budget ID or set the YNAB_BUDGET_ID environment variable.";
        }
        const offset = input.offset || 0;
        const limit = Math.min(input.limit || 100, 500);
        try {
            logger.info(`Fetching transactions for budget ${budgetId} and month ${input.month}`);
            // Use month-specific endpoint
            const monthDate = input.month + "-01"; // Convert YYYY-MM to YYYY-MM-DD
            const response = await this.api.transactions.getTransactionsByMonth(budgetId, monthDate);
            const allTransactions = response.data.transactions || [];
            // Filter out deleted transactions and optionally filter for payments only
            let activeTransactions = allTransactions
                .filter((t) => !t.deleted);
            // Apply payments-only filter if requested
            if (input.paymentsOnly) {
                activeTransactions = activeTransactions.filter((t) => !t.transfer_transaction_id);
            }
            // Sort by date (newest first)
            activeTransactions = activeTransactions.sort((a, b) => {
                const dateCompare = b.date.localeCompare(a.date);
                if (dateCompare !== 0)
                    return dateCompare;
                // If same date, sort by creation (using ID as proxy)
                return b.id.localeCompare(a.id);
            });
            // Apply pagination
            const paginatedTransactions = activeTransactions.slice(offset, offset + limit);
            // Transform transactions
            const transformedTransactions = this.transformTransactions(paginatedTransactions);
            // Group related transfer transactions (skip if payments-only mode)
            const relatedTransactions = input.paymentsOnly
                ? {}
                : this.groupRelatedTransactions(transformedTransactions);
            // Calculate summary for current page
            const summary = this.calculateSummary(transformedTransactions, allTransactions);
            // Pagination metadata
            const pagination = {
                offset,
                limit,
                total: activeTransactions.length,
                has_more: offset + limit < activeTransactions.length,
                next_offset: offset + limit < activeTransactions.length
                    ? offset + limit
                    : null,
            };
            return {
                transactions: transformedTransactions,
                related_transactions: relatedTransactions,
                pagination,
                summary,
            };
        }
        catch (error) {
            logger.error(`Error fetching transactions for budget ${budgetId}:`);
            logger.error(JSON.stringify(error, null, 2));
            return `Error fetching transactions: ${error instanceof Error ? error.message : JSON.stringify(error)}`;
        }
    }
    transformTransactions(transactions) {
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
    groupRelatedTransactions(transactions) {
        const groups = {};
        const processedIds = new Set();
        for (const transaction of transactions) {
            if (transaction.transfer_transaction_id &&
                !processedIds.has(transaction.id)) {
                // Find the related transaction
                const related = transactions.find((t) => t.id === transaction.transfer_transaction_id);
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
    calculateSummary(paginatedTransactions, allTransactions) {
        const totalInflow = paginatedTransactions.reduce((sum, t) => sum + t.inflow, 0);
        const totalOutflow = paginatedTransactions.reduce((sum, t) => sum + t.outflow, 0);
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
