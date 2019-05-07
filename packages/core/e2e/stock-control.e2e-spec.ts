import gql from 'graphql-tag';
import path from 'path';

import { PaymentInput } from '../../common/src/generated-shop-types';
import { CreateAddressInput, ProductVariant, StockMovementType, UpdateProductVariantInput } from '../../common/src/generated-types';
import { PaymentMethodHandler } from '../src/config/payment-method/payment-method-handler';
import { OrderState } from '../src/service/helpers/order-state-machine/order-state';

import { TEST_SETUP_TIMEOUT_MS } from './config/test-config';
import { TestAdminClient, TestShopClient } from './test-client';
import { TestServer } from './test-server';
import { assertThrowsWithMessage } from './utils/assert-throws-with-message';

jest.setTimeout(2137 * 1000);

describe('Stock control', () => {
    const adminClient = new TestAdminClient();
    const shopClient = new TestShopClient();
    const server = new TestServer();

    beforeAll(async () => {
        const token = await server.init(
            {
                productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-stock-control.csv'),
                customerCount: 2,
            },
            {
                paymentOptions: {
                    paymentMethodHandlers: [testPaymentMethod],
                },
            },
        );
        await shopClient.init();
        await adminClient.init();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    describe('stock adjustments', () => {

        let variants: ProductVariant[];

        it('stockMovements are initially empty', async () => {
            const result = await adminClient.query(GET_STOCK_MOVEMENT, { id: 'T_1' });

            variants = result.product.variants;
            for (const variant of variants) {
                expect(variant.stockMovements.items).toEqual([]);
                expect(variant.stockMovements.totalItems).toEqual(0);
            }
        });

        it('updating ProductVariant with same stockOnHand does not create a StockMovement', async () => {
            const result = await adminClient.query(UPDATE_STOCK_ON_HAND, {
                input: [
                    {
                        id: variants[0].id,
                        stockOnHand: variants[0].stockOnHand,
                    },
                ] as UpdateProductVariantInput[],
            });

            expect(result.updateProductVariants[0].stockMovements.items).toEqual([]);
            expect(result.updateProductVariants[0].stockMovements.totalItems).toEqual(0);
        });

        it('increasing stockOnHand creates a StockMovement with correct quantity', async () => {
            const result = await adminClient.query(UPDATE_STOCK_ON_HAND, {
                input: [
                    {
                        id: variants[0].id,
                        stockOnHand: variants[0].stockOnHand + 5,
                    },
                ] as UpdateProductVariantInput[],
            });

            expect(result.updateProductVariants[0].stockOnHand).toBe(5);
            expect(result.updateProductVariants[0].stockMovements.totalItems).toEqual(1);
            expect(result.updateProductVariants[0].stockMovements.items[0].type).toBe(StockMovementType.ADJUSTMENT);
            expect(result.updateProductVariants[0].stockMovements.items[0].quantity).toBe(5);
        });

        it('decreasing stockOnHand creates a StockMovement with correct quantity', async () => {
            const result = await adminClient.query(UPDATE_STOCK_ON_HAND, {
                input: [
                    {
                        id: variants[0].id,
                        stockOnHand: variants[0].stockOnHand + 5 - 2,
                    },
                ] as UpdateProductVariantInput[],
            });

            expect(result.updateProductVariants[0].stockOnHand).toBe(3);
            expect(result.updateProductVariants[0].stockMovements.totalItems).toEqual(2);
            expect(result.updateProductVariants[0].stockMovements.items[1].type).toBe(StockMovementType.ADJUSTMENT);
            expect(result.updateProductVariants[0].stockMovements.items[1].quantity).toBe(-2);
        });

        it('attempting to set a negative stockOnHand throws', assertThrowsWithMessage(
            async () => {
                const result = await adminClient.query(UPDATE_STOCK_ON_HAND, {
                    input: [
                        {
                            id: variants[0].id,
                            stockOnHand: -1,
                        },
                    ] as UpdateProductVariantInput[],
                });
            },
            'stockOnHand cannot be a negative value'),
        );
    });

    describe('sales', () => {

        beforeAll(async () => {
            const { product } = await adminClient.query(GET_STOCK_MOVEMENT, { id: 'T_2' });
            const [variant1, variant2]: ProductVariant[] = product.variants;

            await adminClient.query(UPDATE_STOCK_ON_HAND, {
                input: [
                    {
                        id: variant1.id,
                        stockOnHand: 5,
                        trackInventory: false,
                    },
                    {
                        id: variant2.id,
                        stockOnHand: 5,
                        trackInventory: true,
                    },
                ] as UpdateProductVariantInput[],
            });

            // Add items to order and check out
            await shopClient.asUserWithCredentials('hayden.zieme12@hotmail.com', 'test');
            await shopClient.query(ADD_ITEM_TO_ORDER, { productVariantId: variant1.id, quantity: 2 });
            await shopClient.query(ADD_ITEM_TO_ORDER, { productVariantId: variant2.id, quantity: 3 });
            await shopClient.query(SET_SHIPPING_ADDRESS, {
                input: {
                    streetLine1: '1 Test Street',
                    countryCode: 'GB',
                } as CreateAddressInput,
            });
            await shopClient.query(TRANSITION_TO_STATE, { state: 'ArrangingPayment' as OrderState });
            await shopClient.query(ADD_PAYMENT, {
                input: {
                    method: testPaymentMethod.code,
                    metadata: {},
                } as PaymentInput,
            });
        });

        it('creates a Sale when order completed', async () => {
            const result = await adminClient.query(GET_STOCK_MOVEMENT, { id: 'T_2' });
            const [variant1, variant2]: ProductVariant[] = result.product.variants;

            expect(variant1.stockMovements.totalItems).toBe(2);
            expect(variant1.stockMovements.items[1].type).toBe(StockMovementType.SALE);
            expect(variant1.stockMovements.items[1].quantity).toBe(-2);

            expect(variant2.stockMovements.totalItems).toBe(2);
            expect(variant2.stockMovements.items[1].type).toBe(StockMovementType.SALE);
            expect(variant2.stockMovements.items[1].quantity).toBe(-3);
        });

        it('stockOnHand is updated according to trackInventory setting', async () => {
            const result = await adminClient.query(GET_STOCK_MOVEMENT, { id: 'T_2' });
            const [variant1, variant2]: ProductVariant[] = result.product.variants;

            expect(variant1.stockOnHand).toBe(5); // untracked inventory
            expect(variant2.stockOnHand).toBe(2); // tracked inventory
        });
    });

});

const testPaymentMethod = new PaymentMethodHandler({
    code: 'test-payment-method',
    description: 'Test Payment Method',
    args: {},
    createPayment: (order, args, metadata) => {
        return {
            amount: order.total,
            state: 'Settled',
            transactionId: '12345',
            metadata,
        };
    },
});

const VARIANT_WITH_STOCK_FRAGMENT = gql`
    fragment VariantWithStock on ProductVariant {
        id
        stockOnHand
        stockMovements {
            items {
                ...on StockMovement {
                    id
                    type
                    quantity
                }
            }
            totalItems
        }
    }
`;

const GET_STOCK_MOVEMENT = gql`
    query ($id: ID!) {
        product(id: $id) {
            id
            variants {
                ...VariantWithStock
            }
        }
    }
    ${VARIANT_WITH_STOCK_FRAGMENT}
`;

const UPDATE_STOCK_ON_HAND = gql`
    mutation ($input: [UpdateProductVariantInput!]!) {
        updateProductVariants(input: $input) {
            ...VariantWithStock
        }
    }
    ${VARIANT_WITH_STOCK_FRAGMENT}
`;

const TEST_ORDER_FRAGMENT = gql`
    fragment TestOrderFragment on Order {
        id
        code
        state
        active
        lines {
            id
            quantity
            productVariant {
                id
            }
        }
    }
`;

const ADD_ITEM_TO_ORDER = gql`
    mutation AddItemToOrder($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            ...TestOrderFragment
        }
    }
    ${TEST_ORDER_FRAGMENT}
`;

const SET_SHIPPING_ADDRESS = gql`
    mutation SetShippingAddress($input: CreateAddressInput!) {
        setOrderShippingAddress(input: $input) {
            shippingAddress {
                streetLine1
            }
        }
    }
`;

const TRANSITION_TO_STATE = gql`
    mutation TransitionToState($state: String!) {
        transitionOrderToState(state: $state) {
            id
            state
        }
    }
`;

const ADD_PAYMENT = gql`
    mutation AddPaymentToOrder($input: PaymentInput!) {
        addPaymentToOrder(input: $input) {
            payments {
                id
            }
        }
    }
`;