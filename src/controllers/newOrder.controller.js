import Joi from "joi";
import {
  NewOrder as Order,
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
} from "../models/newOrder.model.js";
import User from "../models/user.model.js";
import Product from "../models/product.model.js";
import Color from "../models/color.model.js";
import { Address } from "../models/address.model.js";
import { withTransaction } from "../utils/withTransaction.js";
import {
  generateOrderId,
  generateReturnId,
  generateCancelId,
  createStatusHistoryEntry,
} from "../services/orderUtils.js";
import { EmailQueue } from "../queue/producer.js";
const { paymentService } = await import("../services/paymetService.js");
import {
  prepareShiprocketOrderData,
  updateOrderWithAWBData,
  updateOrderWithShiprocketData,
  createShiprocketReturnOrder,
  updateOrderWithReturnData,
} from "../services/shiprocketUtils.js";
import {
  createAdhocOrder,
  generatePickup,
  assignAWB,
  fetchAddress
} from "../services/shiprocket.js";

const statusMap = Object.values(OrderStatus).reduce((map, statusObj) => {
  map[statusObj.value] = statusObj.next;
  return map;
}, {});

/**
 * Validates if a status transition is allowed (forward-only)
 * Prevents backward transitions (e.g., Shipped -> Ordered)
 */
export const canTransition = (currentStatus, nextStatus) => {
  if (!statusMap[currentStatus]) {
    console.warn(`Current status "${currentStatus}" not found in status map`);
    return false;
  }
  
  // Only allow transitions that are explicitly defined as "next" statuses
  const allowedNextStatuses = statusMap[currentStatus];
  const isAllowed = allowedNextStatuses.includes(nextStatus);
  
  if (!isAllowed) {
    console.warn(
      `Invalid transition attempt: "${currentStatus}" -> "${nextStatus}". ` +
      `Allowed transitions: ${allowedNextStatuses.join(", ")}`
    );
  }
  
  return isAllowed;
};

const orderItemSchema = Joi.object({
  productId: Joi.string().required(),
  colorId: Joi.string().required(),
  size: Joi.string().valid("XS", "S", "M", "L", "XL", "XXL").required(),
  quantity: Joi.number().integer().min(1).required(),
  price: Joi.number().precision(2).min(0).required(),
  shippingCharges: Joi.number().precision(2).min(0).default(0),
});

const createOrderSchema = Joi.object({
  items: Joi.array().items(orderItemSchema).min(1).required(),
  shippingInfo: Joi.object({
    address: Joi.string().required(),
    city: Joi.string().required(),
    state: Joi.string().required(),
    country: Joi.string().required(),
    postalCode: Joi.string().required(),
    phone: Joi.string().required(),
  }).required(),
  paymentMethod: Joi.string()
    .valid(...Object.values(PaymentMethod))
    .required(),
  paymentProvider: Joi.string()
    .valid("razorpay", "cashfree")
    .allow(null)
    .optional(),
  transactionId: Joi.string().allow(null).optional(),
  shippingCharges: Joi.number().precision(2).min(0).default(0),
  totalAmount: Joi.number().precision(2).min(0).optional(),
  couponCode: Joi.string().allow(null, "").optional(),
  couponDiscount: Joi.number().precision(2).min(0).default(0).optional(),
});

export const createOrder = async (req, res) => {
  console.log("=== ORDER CREATION DEBUG START ===");
  console.log(
    "createOrder called with body:",
    JSON.stringify(req.body, null, 2)
  );
  console.log("createOrder user:", req.user);
  console.log("paymentMethod type:", typeof req.body.paymentMethod);
  console.log("paymentMethod value:", req.body.paymentMethod);
  console.log("paymentProvider:", req.body.paymentProvider);
  console.log("transactionId:", req.body.transactionId);
  console.log("items count:", req.body.items?.length);
  console.log("shippingInfo:", req.body.shippingInfo);

  // Validate request body
  const { error, value } = createOrderSchema.validate(req.body, {
    abortEarly: false,
  });
  if (error) {
    console.log("Validation error:", error.details);
    console.log("=== ORDER CREATION DEBUG END (VALIDATION FAILED) ===");
    return res
      .status(400)
      .json({
        success: false,
        message: "Please order properly.",
        details: error.details,
      });
  }

  const {
    items,
    shippingInfo,
    paymentMethod,
    paymentProvider,
    transactionId,
    shippingCharges,
    totalAmount,
    couponCode,
    couponDiscount,
  } = value;
  const userId = req.user;

  console.log("Validated data:", {
    items,
    shippingInfo,
    paymentMethod,
    paymentProvider,
    transactionId,
    shippingCharges,
    totalAmount,
    userId,
  });
  console.log("Available PaymentMethod values:", Object.values(PaymentMethod));
  console.log(
    "Backend will calculate shipping charges based on payment method"
  );

  console.log("totalAmount:", totalAmount);

  // Additional validation for payment method
  if (!Object.values(PaymentMethod).includes(paymentMethod)) {
    console.log("Invalid payment method:", paymentMethod);
    console.log("=== ORDER CREATION DEBUG END (INVALID PAYMENT METHOD) ===");
    return res.status(400).json({
      success: false,
      message: "Invalid payment method. Please select COD or ONLINE.",
      received: paymentMethod,
    });
  }

  const paymentConfig = await paymentService.getPaymentConfig();

  if (paymentMethod === PaymentMethod.COD && !paymentConfig?.codEnabled) {
    return res.status(400).json({
      success: false,
      message:
        "Cash on Delivery is currently disabled. Please use online payment.",
    });
  }

  if (
    paymentMethod === PaymentMethod.ONLINE &&
    !paymentConfig?.onlinePaymentEnabled
  ) {
    return res.status(400).json({
      success: false,
      message:
        "Online payment is currently disabled. Please use Cash on Delivery.",
    });
  }

  if (!userId) {
    console.log("=== ORDER CREATION DEBUG END (NO USER ID) ===");
    return res
      .status(401)
      .json({ success: false, message: "User not authenticated" });
  }

  console.log("Fetching user and cart for userId:", userId);
  // Fetch user & cart
  const userDoc = await User.findById(userId).populate({
    path: "cartList",
    populate: { path: "items.productId items.color" },
  });

  console.log("User document found:", !!userDoc);
  console.log("User cart found:", !!userDoc?.cartList);
  console.log("Cart items count:", userDoc?.cartList?.items?.length || 0);

  if (!userDoc?.cartList) {
    console.log("=== ORDER CREATION DEBUG END (CART NOT FOUND) ===");
    return res.status(400).json({ success: false, message: "Cart not found" });
  }

  console.log("User cart items:", userDoc.cartList.items);

  const cartItems = userDoc.cartList.items;
  console.log("Cart items:", cartItems);

  // Validate cart contents match requested items
  for (const item of items) {
    console.log("Validating item:", item);
    const matchedCartItem = cartItems.find(
      (cartItem) =>
        cartItem.productId._id.toString() === item.productId &&
        cartItem.color._id.toString() === item.colorId &&
        cartItem.size === item.size
    );
    console.log(
      "Matched cart item.....:",
      matchedCartItem.productId._id.toString(),
      item.productId,
      typeof item.productId
    );
    console.log("Matched cart item:", matchedCartItem);

    if (!matchedCartItem) {
      return res
        .status(400)
        .json({
          success: false,
          message: `Item ${item.productId} not found in your cart.`,
        });
    }
    console.log("Item validated successfully");
  }

  try {
    console.log("Starting transaction for order creation...");
    await withTransaction(async (session) => {
      // Generate unique orderId
      let orderId;
      do {
        orderId = generateOrderId();
      } while (await Order.exists({ orderId }).session(session));

      console.log("Generated orderId:", orderId);
      const orderItems = [];

      // Loop over requested items and prepare order items, check stock, update stock
      console.log("Processing items for order creation...");
      for (const item of items) {
        console.log("Processing item:", item);
        const { productId, colorId, size, quantity } = item;

        const color = await Color.findOne({
          _id: colorId,
          isActive: true,
        }).session(session);
        if (!color) throw new Error(`Color not found`);

        const product = await Product.findOne({
          _id: productId,
          isActive: true,
        }).session(session);
        if (!product) throw new Error(`Product not found`);

        const variant = product.variants.find(
          (v) =>
            v.color.toString() === colorId &&
            v.sizes.some((s) => s.size === size)
        );
        if (!variant)
          throw new Error(`Variant not found for product ${product.name}`);

        const sizeStock = variant.sizes.find((s) => s.size === size);
        if (sizeStock.stock < quantity) {
          throw new Error(
            `Insufficient stock for ${product.name} - size ${size}`
          );
        }

        // Deduct stock for this variant and size
        sizeStock.stock -= quantity;
        await product.save({ session });

        // Calculate price (backend controlled)
        const price = product.isOnSale
          ? product.salePrice.discountedPrice
          : product.nonSalePrice.discountedPrice;


        // Get the best available image
        const productImage = variant.images?.[0] ||
          product.images?.[0] || { secure_url: variant.orderImage };

        orderItems.push({
          product: {
            productId: product._id,
            name: product.name,
            image: {
              id: productImage.id || null,
              secure_url:
                productImage.secure_url ||
                productImage ||
                "/placeholder-product.jpg",
            },
          },
          color: {
            name: color.name,
            hexCode: color.hexCode,
          },
          size,
          quantity,
          amount: price,
          orderStatus: OrderStatus.ORDERED.value,
          statusHistory: [createStatusHistoryEntry(OrderStatus.ORDERED.value)],
        });
      }

      // Calculate total shipping charges for the order
      let totalOrderShippingCharges = 0;
      if (paymentMethod === PaymentMethod.COD) {
        totalOrderShippingCharges = 50; // ₹50 for COD orders
      } else if (paymentMethod === PaymentMethod.ONLINE) {
        // For online payments, calculate based on order total
        const orderSubtotal = orderItems.reduce(
          (sum, item) => sum + item.amount.price * item.quantity,
          0
        );
        if (orderSubtotal < 599) {
          totalOrderShippingCharges = 50; // ₹50 for orders below ₹599
        } else {
          totalOrderShippingCharges = 0; // Free shipping for orders ₹599 and above
        }
      }

      // Determine payment status based on payment method
      let paymentStatus = PaymentStatus.PENDING;
      console.log("Payment status determination:", {
        paymentMethod,
        transactionId,
        hasTransactionId: !!transactionId,
      });

      if (paymentMethod === PaymentMethod.COD) {
        paymentStatus = PaymentStatus.PENDING; // COD is pending until delivery
      } else if (paymentMethod === PaymentMethod.ONLINE && transactionId) {
        paymentStatus = PaymentStatus.PAID; // Online payment is already verified
        console.log(
          "Setting payment status to PAID for online payment with transaction ID:",
          transactionId
        );
      } else if (paymentMethod === PaymentMethod.ONLINE && !transactionId) {
        console.log(
          "Online payment but no transaction ID - keeping status as PENDING"
        );
      }

      // Create single order with all items
      console.log("Creating order with transaction ID:", transactionId);
      console.log("Creating order with payment provider:", paymentProvider);
      console.log("Creating order with payment status:", paymentStatus);
      console.log(
        "Creating order with total shipping charges:",
        totalOrderShippingCharges
      );
      console.log("Order items count:", orderItems.length);

      // Calculate subtotal
      const subtotal = orderItems.reduce(
        (sum, item) => sum + item.amount * item.quantity,
        0
      );

      // Apply coupon discount if provided
      const appliedCouponDiscount = couponDiscount || 0;
      const finalSubtotal = Math.max(0, subtotal - appliedCouponDiscount);

      // Calculate final total
      const finalTotal = finalSubtotal + totalOrderShippingCharges;

      // Get coupon details if coupon code is provided and increment usage count
      let couponData = null;
      if (couponCode && appliedCouponDiscount > 0) {
        const Coupon = (await import("../models/coupon.model.js")).default;
        const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() }).session(session);
        if (coupon) {
          // Increment usage count
          coupon.usedCount += 1;
          await coupon.save({ session });

          couponData = {
            code: coupon.code,
            discountAmount: appliedCouponDiscount,
            discountType: coupon.discountType,
            discountValue: coupon.discountValue,
          };
        }
      }

      const order = new Order({
        orderId,
        user: userId,
        items: orderItems,
        shippingInfo,
        paymentMethod,
        paymentProvider: paymentProvider || null,
        transactionId: transactionId || null,
        paymentStatus,
        shippingCharges: totalOrderShippingCharges,
        orderedAt: new Date(),
        coupon: couponData,
        amount: {
          shippingCharges: totalOrderShippingCharges,
          subtotal: subtotal,
          couponDiscount: appliedCouponDiscount,
          totalAmount: finalTotal,
        },
      });

      console.log("Saving order to database...");
      const savedOrder = await order.save({ session });
      console.log("Order saved successfully with ID:", savedOrder._id);

      // Remove ordered items from user's cart
      console.log("Removing items from cart...");
      userDoc.cartList.items = cartItems.filter(
        (cartItem) =>
          !items.some(
            (orderItem) =>
              cartItem.productId._id.toString() === orderItem.productId &&
              cartItem.color._id.toString() === orderItem.colorId &&
              cartItem.size === orderItem.size
          )
      );
      await userDoc.cartList.save({ session });
      console.log("Cart updated successfully");

      // Send order confirmation email
      try {
        const emailData = {
          type: "order_confirmation",
          email: userDoc.email,
          subject: `Order Confirmation - ${orderId}`,
          template: "OrderConfirmation.ejs",
          data: {
            order: savedOrder,
            user: {
              name:
                `${userDoc.firstname || ""} ${userDoc.lastname || ""}`.trim() ||
                "Customer",
              email: userDoc.email,
            },
          },
        };
       

        await EmailQueue.add("send-order-confirmation", emailData, {
          delay: 1000, // 1 second delay to ensure order is fully processed
          priority: 1,
        });

        console.log("Order confirmation email queued successfully");
      } catch (emailError) {
        console.error("Failed to queue order confirmation email:", emailError);
        // Don't fail the order creation if email fails
      }

      console.log("=== ORDER CREATION DEBUG END (SUCCESS) ===");
      return res.status(201).json({
        success: true,
        message: "Order placed successfully",
        orderId,
        order: savedOrder,
      });
    });
  } catch (err) {
    console.log("=== ORDER CREATION DEBUG END (ERROR) ===");
    console.error("Order creation error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getUserOrders = async (req, res) => {
  try {
    const userId = req.user;

    const orders = await Order.find({ user: userId })
      .sort({ createdAt: -1 })
      .lean();

    const transformedOrders = orders.map((order) => {
      const productsMap = {};

      for (const item of order.items) {
        const variantKey = `${item.product.productId}_${item.color.name}_${item.size}`;

        if (!productsMap[variantKey]) {
          productsMap[variantKey] = {
            productId: item.product.productId,
            name: item.product.name,
            image: item.product.image,
            color: item.color,
            size: item.size,
            amount: item.amount,
            quantity: 0,
            itemsGroupedByStatus: {},
          };
        }

        if (!productsMap[variantKey].itemsGroupedByStatus[item.orderStatus]) {
          productsMap[variantKey].itemsGroupedByStatus[item.orderStatus] = [];
        }

        productsMap[variantKey].itemsGroupedByStatus[item.orderStatus].push({
          _id: item._id,
          orderStatus: item.orderStatus,
          cancelledAt: item.cancelledAt,
          cancelId: item.cancelId,
          returnRequestedAt: item.returnRequestedAt,
          returnId: item.returnId,
          returnedAt: item.returnedAt,
          refundAmount: item.refundAmount,
          refundProcessedAt: item.refundProcessedAt,
          refundStatus: item.refundStatus,
          returnRequestNote: item.returnRequestNote,
          statusHistory: item.statusHistory,
          size: item.size,
          quantity: item.quantity,
        });

        productsMap[variantKey].quantity += item.quantity;
      }

      // Calculate total amount and items
      // Calculate total items
      const totalItems = order.items.reduce(
        (sum, item) => sum + item.quantity,
        0
      );

      // Determine overall order status based on item statuses
      // Priority: Final statuses > Return statuses > Shipped > Ordered
      const statuses = order.items.map((i) => i.orderStatus);
      let overallStatus = OrderStatus.ORDERED.value;
      
      // Check for final statuses (all items must be in same final status)
      if (statuses.every((s) => s === OrderStatus.DELIVERED.value))
        overallStatus = OrderStatus.DELIVERED.value;
      else if (statuses.every((s) => s === OrderStatus.CANCELLED.value))
        overallStatus = OrderStatus.CANCELLED.value;
      else if (statuses.every((s) => s === OrderStatus.RETURNED.value))
        overallStatus = OrderStatus.RETURNED.value;
      else if (statuses.every((s) => s === OrderStatus.REFUNDED.value))
        overallStatus = OrderStatus.REFUNDED.value;
      // Check for return-related statuses
      else if (statuses.includes(OrderStatus.RETURN_REQUESTED.value))
        overallStatus = OrderStatus.RETURN_REQUESTED.value;
      else if (statuses.includes(OrderStatus.DEPARTED_FOR_RETURNING.value))
        overallStatus = OrderStatus.DEPARTED_FOR_RETURNING.value;
      else if (statuses.includes(OrderStatus.RETURN_CANCELLED.value))
        overallStatus = OrderStatus.RETURN_CANCELLED.value;
      // Check for shipped status
      else if (statuses.includes(OrderStatus.SHIPPED.value))
        overallStatus = OrderStatus.SHIPPED.value;

      return {
        _id: order._id,
        orderId: order.orderId,
        overallStatus: overallStatus,
        products: Object.values(productsMap),
        items: order.items, // Include full items array
        orderedAt: order.orderedAt,
        totalAmount: order.amount?.totalAmount || order.totalAmount || 0,
        totalItems: totalItems,
        amount: order.amount, // Include full amount breakdown
        coupon: order.coupon, // Include coupon details
        shippingInfo: order.shippingInfo,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        paymentProvider: order.paymentProvider,
        transactionId: order.transactionId,
        trackingNumber: order.trackingNumber,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      };
    });

    return res.status(200).json({ success: true, data: transformedOrders });
  } catch (err) {
    console.error("getUserOrders error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getOrderByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId, user: req.user }).lean();
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const productsMap = {};
    for (const item of order.items) {
      const variantKey = `${item.product.productId}_${item.color.name}_${item.size}`;

      if (!productsMap[variantKey]) {
        productsMap[variantKey] = {
          productId: item.product.productId,
          name: item.product.name,
          image: item.product.image,
          color: item.color,
          size: item.size,
          amount: item.amount,
          quantity: 0,
          items: [],
          itemsGroupedByStatus: {}, // Add itemsGroupedByStatus for consistency
        };
      }

      productsMap[variantKey].quantity += item.quantity;
      
      // Add to items array
      productsMap[variantKey].items.push({
        _id: item._id,
        orderStatus: item.orderStatus,
        cancelledAt: item.cancelledAt,
        cancelId: item.cancelId,
        returnRequestedAt: item.returnRequestedAt,
        returnId: item.returnId,
        returnedAt: item.returnedAt,
        refundAmount: item.refundAmount,
        refundProcessedAt: item.refundProcessedAt,
        refundStatus: item.refundStatus,
        returnRequestNote: item.returnRequestNote,
        statusHistory: item.statusHistory,
        quantity: item.quantity, // Fix typo: quantiy -> quantity
        size: item.size,
        color: item.color,
        amount: item.amount,
      });

      // Add to itemsGroupedByStatus structure (for consistency with getUserOrders)
      if (!productsMap[variantKey].itemsGroupedByStatus[item.orderStatus]) {
        productsMap[variantKey].itemsGroupedByStatus[item.orderStatus] = [];
      }

      productsMap[variantKey].itemsGroupedByStatus[item.orderStatus].push({
        _id: item._id,
        orderStatus: item.orderStatus,
        cancelledAt: item.cancelledAt,
        cancelId: item.cancelId,
        returnRequestedAt: item.returnRequestedAt,
        returnId: item.returnId,
        returnedAt: item.returnedAt,
        refundAmount: item.refundAmount,
        refundProcessedAt: item.refundProcessedAt,
        refundStatus: item.refundStatus,
        returnRequestNote: item.returnRequestNote,
        statusHistory: item.statusHistory,
        quantity: item.quantity,
        size: item.size,
        color: item.color,
        amount: item.amount,
      });
    }

    const products = Object.values(productsMap);

    // Determine overall order status based on item statuses
    // Priority: Final statuses > Return statuses > Shipped > Ordered
    const statuses = order.items.map((i) => i.orderStatus);
    let overallStatus = OrderStatus.ORDERED.value;
    
    // Check for final statuses (all items must be in same final status)
    if (statuses.every((s) => s === OrderStatus.DELIVERED.value))
      overallStatus = OrderStatus.DELIVERED.value;
    else if (statuses.every((s) => s === OrderStatus.CANCELLED.value))
      overallStatus = OrderStatus.CANCELLED.value;
    else if (statuses.every((s) => s === OrderStatus.RETURNED.value))
      overallStatus = OrderStatus.RETURNED.value;
    else if (statuses.every((s) => s === OrderStatus.REFUNDED.value))
      overallStatus = OrderStatus.REFUNDED.value;
    // Check for return-related statuses
    else if (statuses.includes(OrderStatus.RETURN_REQUESTED.value))
      overallStatus = OrderStatus.RETURN_REQUESTED.value;
    else if (statuses.includes(OrderStatus.DEPARTED_FOR_RETURNING.value))
      overallStatus = OrderStatus.DEPARTED_FOR_RETURNING.value;
    else if (statuses.includes(OrderStatus.RETURN_CANCELLED.value))
      overallStatus = OrderStatus.RETURN_CANCELLED.value;
    // Check for shipped status
    else if (statuses.includes(OrderStatus.SHIPPED.value))
      overallStatus = OrderStatus.SHIPPED.value;

    // Calculate total items
    const totalItems = order.items.reduce(
      (sum, item) => sum + item.quantity,
      0
    );

    const transformedOrder = {
      _id: order._id,
      orderId: order.orderId,
      overallStatus: overallStatus,
      status: overallStatus, // Keep for backward compatibility
      items: order.items, // Include full items array for detailed view
      products, // Grouped products
      orderedAt: order.orderedAt,
      totalAmount: order.amount?.totalAmount || order.totalAmount || 0,
      totalItems: totalItems,
      amount: order.amount, // Include full amount breakdown
      coupon: order.coupon, // Include coupon details
      shippingInfo: order.shippingInfo,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      paymentProvider: order.paymentProvider,
      transactionId: order.transactionId,
      trackingNumber: order.trackingNumber,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };

    return res.status(200).json({ success: true, data: transformedOrder });
  } catch (err) {
    console.error("getOrderByOrderId error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const cancelReturnRequest = async (req, res) => {
  const { itemId, quantity } = req.body;

  if (!itemId || !quantity || quantity < 1) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid item or quantity" });
  }

  try {
    await withTransaction(async (session) => {
      const order = await Order.findOne({
        "items._id": itemId,
        user: req.user,
      }).session(session);
      if (!order) throw new Error("Item not found");

      const itemIndex = order.items.findIndex(
        (i) => i._id.toString() === itemId
      );
      const item = order.items[itemIndex];

      if (
        !canTransition(item.orderStatus, OrderStatus.RETURN_CANCELLED.value)
      ) {
        throw new Error(
          `Cannot cancel return for item with status: ${item.orderStatus}`
        );
      }

      if (quantity > item.quantity) {
        throw new Error("Cancel quantity exceeds return quantity");
      }

      const historyEntry = {
        status: OrderStatus.RETURN_CANCELLED,
        note: "Return cancelled by user",
        timestamp: new Date(),
      };

      if (quantity < item.quantity) {
        // Partial cancel — split batch
        const cancelledBatch = item.toObject({ depopulate: true });
        delete cancelledBatch._id;

        cancelledBatch.quantity = quantity;
        cancelledBatch.orderStatus = OrderStatus.RETURN_CANCELLED;
        cancelledBatch.returnCancelledAt = new Date();
        cancelledBatch.statusHistory = [
          ...cancelledBatch.statusHistory,
          historyEntry,
        ];

        // Remove stale return metadata
        delete cancelledBatch.returnId;
        delete cancelledBatch.returnRequestedAt;
        delete cancelledBatch.returnRequestNote;

        item.quantity -= quantity;
        order.items.push(cancelledBatch);
      } else {
        // Full cancel — update in place
        item.orderStatus = OrderStatus.RETURN_CANCELLED;
        item.returnCancelledAt = new Date();
        item.statusHistory.push(historyEntry);

        // Remove stale return metadata
        delete item.returnId;
        delete item.returnRequestedAt;
        delete item.returnRequestNote;
      }

      await order.save({ session });
      return res
        .status(200)
        .json({
          success: true,
          message: "Return request cancelled successfully",
        });
    });
  } catch (err) {
    console.error("Cancel Return Request Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

//Admin controllers
export const getAllOrders = async (req, res) => {
  try {
    let { page = 1, limit = 20, status, paymentStatus } = req.query;
    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    const filter = {};

    // Per-item status filter
    if (status) {
      filter["items.orderStatus"] = status;
    }

    // Payment status filter
    if (paymentStatus) {
      filter.paymentStatus = paymentStatus;
    }

    // ====== 1) Main orders query ======
    const orders = await Order.find(filter)
      .select(
        "orderId user paymentMethod paymentStatus paymentProvider transactionId orderedAt shippingInfo items"
      )
      .populate("user", "name email")
      .populate("items.product.productId", "name image")
      .sort({ orderedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const formattedOrders = orders.map((order) => {
      const statusCounts = {};
      for (const item of order.items) {
        statusCounts[item.orderStatus] =
          (statusCounts[item.orderStatus] || 0) + item.quantity;
      }

      return {
        orderId: order.orderId,
        user: order.user,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        paymentProvider: order.paymentProvider,
        transactionId: order.transactionId,
        orderedAt: order.orderedAt,
        shippingInfo: order.shippingInfo,
        overallStatus: statusCounts,
        totalItems: order.items.reduce((sum, i) => sum + i.quantity, 0),
      };
    });

    const totalDocs = await Order.countDocuments(filter);

    // ====== 2) Global status counts for all orders ======
    const globalCounts = await Order.aggregate([
      { $unwind: "$items" },
      paymentStatus ? { $match: { paymentStatus } } : { $match: {} },
      {
        $group: {
          _id: "$items.orderStatus",
          count: { $sum: "$items.quantity" },
        },
      },
      { $project: { _id: 0, status: "$_id", count: 1 } },
    ]);

    const statusSummary = {};
    globalCounts.forEach((s) => {
      statusSummary[s.status] = s.count;
    });

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalDocs,
      totalPages: Math.ceil(totalDocs / limit),
      data: formattedOrders,
      statusSummary, // Example: { Ordered: 12, Shipped: 4, Cancelled: 3 }
    });
  } catch (err) {
    console.error("getAllOrders error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};



export const getOrderItemsByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId }).lean();
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const productsMap = {};
    for (const item of order.items) {
      const variantKey = `${item.product.productId}_${item.color.name}_${item.size}`;

      if (!productsMap[variantKey]) {
        productsMap[variantKey] = {
          productId: item.product.productId,
          name: item.product.name,
          image: item.product.image,
          color: item.color,
          size: item.size,
          amount: item.amount,
          quantity: 0,
          items: [],
          itemsGroupedByStatus: {}, // Add itemsGroupedByStatus for frontend compatibility
        };
      }

      productsMap[variantKey].quantity += item.quantity;
      
      // Add to items array
      productsMap[variantKey].items.push({
        _id: item._id,
        orderStatus: item.orderStatus,
        cancelledAt: item.cancelledAt,
        cancelId: item.cancelId,
        returnRequestedAt: item.returnRequestedAt,
        returnId: item.returnId,
        returnedAt: item.returnedAt,
        refundAmount: item.refundAmount,
        refundProcessedAt: item.refundProcessedAt,
        refundStatus: item.refundStatus,
        returnRequestNote: item.returnRequestNote,
        statusHistory: item.statusHistory,
        quantity: item.quantity, // Fix typo: quantiy -> quantity
        size: item.size,
        color: item.color,
        amount: item.amount,
      });

      // Add to itemsGroupedByStatus structure (required by frontend StatusUpdateModal)
      if (!productsMap[variantKey].itemsGroupedByStatus[item.orderStatus]) {
        productsMap[variantKey].itemsGroupedByStatus[item.orderStatus] = [];
      }

      productsMap[variantKey].itemsGroupedByStatus[item.orderStatus].push({
        _id: item._id,
        orderStatus: item.orderStatus,
        cancelledAt: item.cancelledAt,
        cancelId: item.cancelId,
        returnRequestedAt: item.returnRequestedAt,
        returnId: item.returnId,
        returnedAt: item.returnedAt,
        refundAmount: item.refundAmount,
        refundProcessedAt: item.refundProcessedAt,
        refundStatus: item.refundStatus,
        returnRequestNote: item.returnRequestNote,
        statusHistory: item.statusHistory,
        quantity: item.quantity,
        size: item.size,
        color: item.color,
        amount: item.amount,
      });
    }

    const products = Object.values(productsMap);

    // Determine overall order status based on item statuses
    // Priority: Final statuses > Return statuses > Shipped > Ordered
    const statuses = order.items.map((i) => i.orderStatus);
    let overallStatus = OrderStatus.ORDERED.value;
    
    // Check for final statuses (all items must be in same final status)
    if (statuses.every((s) => s === OrderStatus.DELIVERED.value))
      overallStatus = OrderStatus.DELIVERED.value;
    else if (statuses.every((s) => s === OrderStatus.CANCELLED.value))
      overallStatus = OrderStatus.CANCELLED.value;
    else if (statuses.every((s) => s === OrderStatus.RETURNED.value))
      overallStatus = OrderStatus.RETURNED.value;
    else if (statuses.every((s) => s === OrderStatus.REFUNDED.value))
      overallStatus = OrderStatus.REFUNDED.value;
    // Check for return-related statuses
    else if (statuses.includes(OrderStatus.RETURN_REQUESTED.value))
      overallStatus = OrderStatus.RETURN_REQUESTED.value;
    else if (statuses.includes(OrderStatus.DEPARTED_FOR_RETURNING.value))
      overallStatus = OrderStatus.DEPARTED_FOR_RETURNING.value;
    else if (statuses.includes(OrderStatus.RETURN_CANCELLED.value))
      overallStatus = OrderStatus.RETURN_CANCELLED.value;
    // Check for shipped status
    else if (statuses.includes(OrderStatus.SHIPPED.value))
      overallStatus = OrderStatus.SHIPPED.value;

    // Calculate total amount and items
    const totalAmount = order.amount.totalAmount;
    const totalItems = order.items.reduce(
      (sum, item) => sum + item.quantity,
      0
    );

    const user = await User.findById(order.user).select("firstname lastname email");
    console.log("user : ", user);

    const transformedOrder = {
      _id: order._id,
      orderId: order.orderId,
      overallStatus: overallStatus,
      status: overallStatus, // Keep for backward compatibility
      items: order.items, // Include full items array for detailed view
      products, // Grouped products
      orderedAt: order.orderedAt,
      totalAmount: totalAmount,
      totalItems: totalItems,
      amount: order.amount || {
        subtotal: order.items.reduce((sum, item) => sum + (item.amount * item.quantity), 0),
        couponDiscount: order.coupon?.discountAmount || 0,
        shippingCharges: order.amount?.shippingCharges || 0,
        totalAmount: totalAmount
      },
      coupon: order.coupon || null,
      shippingInfo: order.shippingInfo,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      paymentProvider: order.paymentProvider,
      transactionId: order.transactionId,
      trackingNumber: order.trackingNumber,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      user: {name : user.firstname, email : user.email},
    };

    return res.status(200).json({ success: true, data: transformedOrder });
  } catch (err) {
    console.error("getOrderItemsByOrderId error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};


// POST /admin/items/:itemId/refund
export const processRefund = async (req, res) => {
  const { refundAmount, quantity, itemId } = req.body; // quantity optional, defaults to full batch

  if (!itemId || !refundAmount || refundAmount <= 0) {
    return res.status(400).json({ success: false, message: "Invalid request" });
  }

  try {
    await withTransaction(async (session) => {
      const order = await Order.findOne({ "items._id": itemId }).session(
        session
      );
      if (!order) throw new Error("Item not found");

      const itemIndex = order.items.findIndex(
        (i) => i._id.toString() === itemId
      );
      const item = order.items[itemIndex];
      if (!item) throw new Error("Item not found in order");

      // Default to full batch
      const refundQty = quantity && quantity > 0 ? quantity : item.quantity;
      if (refundQty > item.quantity)
        throw new Error("Refund quantity exceeds item quantity");

      // Validate status transition
      if (!canTransition(item.orderStatus, OrderStatus.REFUNDED.value)) {
        throw new Error(`Cannot refund item with status: ${item.orderStatus}`);
      }

      if (refundQty < item.quantity) {
        // Partial refund → split the batch
        const refundedBatch = {
          ...item.toObject(),
          quantity: refundQty,
          orderStatus: OrderStatus.REFUNDED.value,
          refundAmount: refundAmount,
          refundStatus: "Refunded",
          refundProcessedAt: new Date(),
          statusHistory: [
            ...item.statusHistory,
            {
              status: OrderStatus.REFUNDED.value,
              note: "Refund processed by admin",
              changedAt: new Date(),
            },
          ],
        };

        // Reduce original quantity
        item.quantity -= refundQty;

        // Push refunded batch
        order.items.push(refundedBatch);
      } else {
        // Full batch refund
        item.orderStatus = OrderStatus.REFUNDED.value;
        item.refundAmount = refundAmount;
        item.refundStatus = "Refunded";
        item.refundProcessedAt = new Date();
        item.statusHistory.push({
          status: OrderStatus.REFUNDED.value,
          note: "Refund processed by admin",
          changedAt: new Date(),
        });
      }

      await order.save({ session });
    });

    return res.status(200).json({
      success: true,
      message: "Refund processed successfully",
    });
  } catch (err) {
    console.error("processRefund error:", err);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Address Management Functions

const addressSchema = Joi.object({
  address: Joi.string().required(),
  city: Joi.string().required(),
  state: Joi.string().required(),
  country: Joi.string().default("India"),
  postalCode: Joi.string().required(),
  phone: Joi.string().required(),
  isDefault: Joi.boolean().default(false),
});

// Get user addresses
export const getUserAddresses = async (req, res) => {
  try {
    const userId = req.user;

    const addresses = await Address.find({
      user: userId,
      isActive: true,
    }).sort({ isDefault: -1, createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: addresses,
    });
  } catch (err) {
    console.error("getUserAddresses error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Add new address
export const addAddress = async (req, res) => {
  try {
    const userId = req.user;

    // Validate request body
    const { error, value } = addressSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid address details",
        details: error.details,
      });
    }

    const { address, city, state, country, postalCode, phone, isDefault } =
      value;

    // If this is the first address, make it default
    const existingAddresses = await Address.countDocuments({
      user: userId,
      isActive: true,
    });
    const shouldBeDefault = isDefault || existingAddresses === 0;

    const newAddress = new Address({
      user: userId,
      address,
      city,
      state,
      country,
      postalCode,
      phone,
      isDefault: shouldBeDefault,
    });

    await newAddress.save();

    return res.status(201).json({
      success: true,
      message: "Address added successfully",
      data: newAddress,
    });
  } catch (err) {
    console.error("addAddress error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Update address
export const updateAddress = async (req, res) => {
  try {
    const userId = req.user;
    const { addressId } = req.params;

    // Validate request body
    const { error, value } = addressSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid address details",
        details: error.details,
      });
    }

    const { address, city, state, country, postalCode, phone, isDefault } =
      value;

    // Check if address belongs to user
    const existingAddress = await Address.findOne({
      _id: addressId,
      user: userId,
      isActive: true,
    });

    if (!existingAddress) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    // Update address
    const updatedAddress = await Address.findByIdAndUpdate(
      addressId,
      {
        address,
        city,
        state,
        country,
        postalCode,
        phone,
        isDefault,
      },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Address updated successfully",
      data: updatedAddress,
    });
  } catch (err) {
    console.error("updateAddress error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Delete address
export const deleteAddress = async (req, res) => {
  try {
    const userId = req.user;
    const { addressId } = req.params;

    // Check if address belongs to user
    const existingAddress = await Address.findOne({
      _id: addressId,
      user: userId,
      isActive: true,
    });

    if (!existingAddress) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    // Soft delete address
    await Address.findByIdAndUpdate(addressId, { isActive: false });

    // If deleted address was default, make another address default
    if (existingAddress.isDefault) {
      const nextAddress = await Address.findOne({
        user: userId,
        isActive: true,
        _id: { $ne: addressId },
      });

      if (nextAddress) {
        await Address.findByIdAndUpdate(nextAddress._id, { isDefault: true });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Address deleted successfully",
    });
  } catch (err) {
    console.error("deleteAddress error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Request Refund for Cancelled Online Orders
export const requestRefund = async (req, res) => {
  const { orderId, itemId, quantity, refundAccountDetails, note } = req.body;

  // Validation
  if (!orderId || !itemId || !quantity || !refundAccountDetails) {
    return res.status(400).json({
      success: false,
      message:
        "Missing required fields (orderId, itemId, quantity, refundAccountDetails)",
    });
  }

  // Validate account details
  if (
    !refundAccountDetails.accountType ||
    (!refundAccountDetails.upiId && !refundAccountDetails.accountNumber)
  ) {
    return res.status(400).json({
      success: false,
      message: "Please provide valid account details (UPI ID or Bank Account)",
    });
  }

  try {
    const order = await Order.findOne({ orderId, user: req.user });
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    // Find the specific item
    const item = order.items.find((item) => item._id.toString() === itemId);
    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: "Order item not found" });
    }

    // Check if order was cancelled and paid online
    if (!canTransition(item.orderStatus, "Refunded")) {
      return res.status(400).json({
        success: false,
        message: "This item is not eligible for refund",
      });
    }

    // Check if already refunded
    if (item.refundStatus === PaymentStatus.REFUNDED) {
      return res.status(400).json({
        success: false,
        message: "Refund already processed for this item",
      });
    }

    // Check if refund already requested
    if (item.refundRequestedAt) {
      return res.status(400).json({
        success: false,
        message: "Refund already requested for this item",
      });
    }

    // Validate quantity doesn't exceed cancelled quantity
    if (quantity > item.quantity) {
      return res.status(400).json({
        success: false,
        message: "Requested refund quantity exceeds cancelled quantity",
      });
    }

    // Calculate refund amount
    const refundAmount = item.amount.totalAmount * quantity;

    // Update item with refund request details
    item.refundAmount = refundAmount;
    item.refundStatus = PaymentStatus.PENDING;
    item.refundRequestedAt = new Date();
    item.refundRequestNote = note || "User requested refund for cancelled item";
    item.refundAccountDetails = refundAccountDetails;

    // Add status history entry
    item.statusHistory.push({
      status: item.orderStatus,
      note: "Refund requested - awaiting admin approval",
      changedAt: new Date(),
    });

    await order.save();

    return res.status(200).json({
      success: true,
      message: "Refund request submitted successfully",
      data: {
        refundAmount,
        status: PaymentStatus.PENDING,
        requestedAt: item.refundRequestedAt,
      },
    });
  } catch (err) {
    console.error("requestRefund error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while processing refund request",
    });
  }
};

// Get User Refund Requests (for user to track their requests)
export const getUserRefundRequests = async (req, res) => {
  try {
    const orders = await Order.find({
      user: req.user,
      "items.refundRequestedAt": { $exists: true },
    }).populate("user", "firstname lastname email");

    const refundRequests = [];

    orders.forEach((order) => {
      order.items.forEach((item) => {
        if (item.refundRequestedAt) {
          refundRequests.push({
            orderId: order.orderId,
            itemId: item._id,
            product: item.product,
            size: item.size,
            color: item.color,
            quantity: item.quantity,
            refundAmount: item.refundAmount,
            refundStatus: item.refundStatus,
            refundRequestedAt: item.refundRequestedAt,
            refundApprovedAt: item.refundApprovedAt,
            refundRejectedAt: item.refundRejectedAt,
            refundRejectionReason: item.refundRejectionReason,
            orderedAt: order.orderedAt,
          });
        }
      });
    });

    // Sort by request date (newest first)
    refundRequests.sort(
      (a, b) => new Date(b.refundRequestedAt) - new Date(a.refundRequestedAt)
    );

    return res.status(200).json({
      success: true,
      data: refundRequests,
    });
  } catch (err) {
    console.error("getUserRefundRequests error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Admin: Get All Refund Requests
export const getAllRefundRequests = async (req, res) => {
  try {
    // Find all orders that have refund requests
    const orders = await Order.find({
      "items.refundRequestedAt": { $exists: true },
    })
      .populate("user", "firstname lastname email")
      .lean();

    const refundRequests = [];

    orders.forEach((order) => {
      order.items.forEach((item) => {
        if (item.refundRequestedAt) {
          refundRequests.push({
            id: `${order._id}-${item._id}`, // Composite ID for frontend
            orderId: order.orderId,
            itemId: item._id.toString(),
            customerName: `${order.user.firstname}`,
            customerEmail: order.user.email,
            productName: item.product.name,
            size: item.size,
            color: item.color?.name || "N/A",
            quantity: item.quantity,
            refundAmount: item.refundAmount,
            refundStatus: item.refundStatus,
            refundRequestedAt: item.refundRequestedAt,
            refundApprovedAt: item.refundApprovedAt,
            refundRejectedAt: item.refundRejectedAt,
            refundRejectionReason: item.refundRejectionReason,
            refundRequestNote: item.refundRequestNote,
            accountType: item.refundAccountDetails?.accountType,
            upiId: item.refundAccountDetails?.upiId,
            phoneNumber: item.refundAccountDetails?.phoneNumber,
            bankName: item.refundAccountDetails?.bankName,
            accountNumber: item.refundAccountDetails?.accountNumber,
            ifscCode: item.refundAccountDetails?.ifscCode,
            accountHolderName: item.refundAccountDetails?.accountHolderName,
            orderedAt: order.orderedAt,
            transactionId: order.transactionId,
            paymentMethod: order.paymentMethod,
            totalAmount: order.totalAmount,
          });
        }
      });
    });

    // Sort by request date (newest first)
    refundRequests.sort(
      (a, b) => new Date(b.refundRequestedAt) - new Date(a.refundRequestedAt)
    );

    return res.status(200).json({
      success: true,
      data: refundRequests,
    });
  } catch (err) {
    console.error("getAllRefundRequests error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Admin: Approve Refund Request
export const approveRefundRequest = async (req, res) => {
  const { refundRequestId } = req.params;
  const { refundAmount } = req.body;

  try {
    if (!refundAmount || refundAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid refund amount",
      });
    }

    // Extract order ID and item ID from composite ID
    const [orderId, itemId] = refundRequestId.split("-");

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const item = order.items.find((item) => item._id.toString() === itemId);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Order item not found",
      });
    }

    if (!item.refundRequestedAt || item.refundStatus !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: "Refund request not found or already processed",
      });
    }

    // Update refund status
    item.refundStatus = "REFUNDED";
    item.refundAmount = refundAmount;
    item.refundApprovedAt = new Date();
    item.refundApprovedBy = req.user; // Admin user ID

    // Add status history entry
    item.statusHistory.push({
      status: item.orderStatus,
      note: `Refund approved by admin - Amount: ₹${refundAmount}`,
      changedAt: new Date(),
    });

    await order.save();

    return res.status(200).json({
      success: true,
      message: "Refund approved successfully",
      data: {
        refundAmount,
        approvedAt: item.refundApprovedAt,
        status: "REFUNDED",
      },
    });
  } catch (err) {
    console.error("approveRefundRequest error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Admin: Reject Refund Request
export const rejectRefundRequest = async (req, res) => {
  const { refundRequestId } = req.params;
  const { rejectionReason } = req.body;

  try {
    if (!rejectionReason?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required",
      });
    }

    // Extract order ID and item ID from composite ID
    const [orderId, itemId] = refundRequestId.split("-");

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const item = order.items.find((item) => item._id.toString() === itemId);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Order item not found",
      });
    }

    if (!item.refundRequestedAt || item.refundStatus !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: "Refund request not found or already processed",
      });
    }

    // Update refund status
    item.refundStatus = "REJECTED";
    item.refundRejectedAt = new Date();
    item.refundRejectedBy = req.user; // Admin user ID
    item.refundRejectionReason = rejectionReason;

    // Add status history entry
    item.statusHistory.push({
      status: item.orderStatus,
      note: `Refund rejected by admin - Reason: ${rejectionReason}`,
      changedAt: new Date(),
    });

    await order.save();

    return res.status(200).json({
      success: true,
      message: "Refund request rejected",
      data: {
        rejectedAt: item.refundRejectedAt,
        rejectionReason,
        status: "REJECTED",
      },
    });
  } catch (err) {
    console.error("rejectRefundRequest error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Set default address
export const setDefaultAddress = async (req, res) => {
  try {
    const userId = req.user;
    const { addressId } = req.params;

    // Check if address belongs to user
    const existingAddress = await Address.findOne({
      _id: addressId,
      user: userId,
      isActive: true,
    });

    if (!existingAddress) {
      return res.status(404).json({
        success: false,
        message: "Address not found",
      });
    }

    // Remove default from all addresses
    await Address.updateMany({ user: userId }, { isDefault: false });

    // Set new default
    await Address.findByIdAndUpdate(addressId, { isDefault: true });

    return res.status(200).json({
      success: true,
      message: "Default address updated successfully",
    });
  } catch (err) {
    console.error("setDefaultAddress error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Get all return requests (Admin)
export const getAllReturnRequests = async (req, res) => {
  try {
    let { page = 1, limit = 20, status } = req.query;
    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    const filter = {};

    // Filter by return status
    if (status && status !== "all") {
      filter["items.orderStatus"] = status;
    } else {
      // Default to return-related statuses
      filter["items.orderStatus"] = {
        $in: ["Return Requested", "Returned", "Refunded", "Return Cancelled"],
      };
    }

    const orders = await Order.find(filter)
      .select(
        "orderId user paymentMethod paymentStatus paymentProvider transactionId orderedAt shippingInfo items"
      )
      .populate("user", "firstname lastname email phoneNumber profile")
      .populate("items.product.productId", "name image")
      .sort({ orderedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Transform data to show only return items
    const returnItems = [];
    orders.forEach((order) => {
      order.items.forEach((item) => {
        if (
          [
            "Return Requested",
            "Returned",
            "Refunded",
            "Return Cancelled",
          ].includes(item.orderStatus)
        ) {
          returnItems.push({
            ...item,
            orderId: order.orderId,
            user: {
              name:
                `${order.user.firstname || ""} ${
                  order.user.lastname || ""
                }`.trim() || "Unknown Customer",
              email: order.user.email || "No email",
              phone: order.user.phoneNumber || "",
              profile: order.user.profile || "",
            },
            orderedAt: order.orderedAt,
            paymentMethod: order.paymentMethod,
            paymentStatus: order.paymentStatus,
            shippingInfo: order.shippingInfo,
          });
        }
      });
    });

    const totalDocs = await Order.countDocuments(filter);

    return res.status(200).json({
      success: true,
      page,
      limit,
      totalDocs,
      totalPages: Math.ceil(totalDocs / limit),
      data: returnItems,
    });
  } catch (err) {
    console.error("getAllReturnRequests error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// Get return request details (Admin)
export const getReturnRequestDetails = async (req, res) => {
  try {
    const { returnId } = req.params;

    const order = await Order.findOne({ "items.returnId": returnId })
      .populate("user")
      .populate("items.product.productId", "name image")
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Return request not found",
      });
    }

    const returnItem = order.items.find((item) => item.returnId === returnId);
    if (!returnItem) {
      return res.status(404).json({
        success: false,
        message: "Return item not found",
      });
    }

    const returnDetails = {
      returnId: returnItem.returnId,
      orderId: order.orderId,
      user: {
        name:
          `${order.user.firstname || ""} ${order.user.lastname || ""}`.trim() ||
          "Unknown Customer",
        email: order.user.email || "No email",
        phone: order.user.phoneNumber || "",
        profile: order.user.profile || "",
      },
      product: {
        name: returnItem.product.name,
        image: returnItem.product.image,
        color: returnItem.color,
        size: returnItem.size,
        quantity: returnItem.quantity,
        amount: returnItem.amount,
      },
      returnInfo: {
        returnRequestedAt: returnItem.returnRequestedAt,
        returnRequestNote: returnItem.returnRequestNote,
        returnedAt: returnItem.returnedAt,
        refundAmount: returnItem.refundAmount,
        refundProcessedAt: returnItem.refundProcessedAt,
        refundStatus: returnItem.refundStatus,
      },
      orderInfo: {
        orderedAt: order.orderedAt,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        shippingInfo: order.shippingInfo,
      },
      statusHistory: returnItem.statusHistory,
      currentStatus: returnItem.orderStatus,
    };

    return res.status(200).json({
      success: true,
      data: returnDetails,
    });
  } catch (err) {
    console.error("getReturnRequestDetails error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Update return request status (Admin)
export const updateReturnRequestStatus = async (req, res) => {
  try {
    const { returnId } = req.params;
    const { status, note = "" } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    await withTransaction(async (session) => {
      const order = await Order.findOne({ "items.returnId": returnId }).session(
        session
      );
      if (!order) throw new Error("Return request not found");

      const itemIndex = order.items.findIndex(
        (item) => item.returnId === returnId
      );
      if (itemIndex === -1) throw new Error("Return item not found");

      const item = order.items[itemIndex];

      // Validate status transition
      if (!canTransition(item.orderStatus, status)) {
        throw new Error(
          `Cannot transition from ${item.orderStatus} to ${status}`
        );
      }

      // Update status and add to history
      item.orderStatus = status;
      item.statusHistory.push({
        status: status,
        note: note,
        changedAt: new Date(),
      });

      // Set specific timestamps based on status
      if (status === "Returned") {
        item.returnedAt = new Date();
      } else if (status === "Refunded") {
        item.refundProcessedAt = new Date();
      }

      await order.save({ session });
    });

    return res.status(200).json({
      success: true,
      message: "Return status updated successfully",
    });
  } catch (err) {
    console.error("updateReturnRequestStatus error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
};

/**
 * Item Status Controller
 * Handles individual item status changes
 */

/**
 * Step 1: Create Adhoc Order in Shiprocket
 * POST /api/admin/newOrders/:orderId/create-adhoc-order
 */
export const createAdhocOrderStep = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { length, breadth, height, weight } = req.body;
    const token = req.shiprocketToken;
    
    const {data: address} = await fetchAddress(token);
    console.log("address : ", address);

    // Validate Shiprocket token
    if (!token) {
      return res
        .status(400)
        .json({ success: false, message: "Shiprocket token required" });
    }

    // Validate shipping dimensions
    if (!length || !breadth || !height || !weight || !address) {
      return res.status(400).json({
        success: false,
        message: "Length, breadth, height, weight, and address are required",
      });
    }

    let order;

    await withTransaction(async (session) => {
      // Find order
      order = await Order.findOne({ orderId })
        .populate("user", "name email")
        .populate("items.product.productId", "name")
        .session(session);

      if (!order) {
        throw new Error("Order not found");
      }

      // Check if adhoc order already created
      if (order.shiprocket?.flags?.adhocOrderCreated) {
        throw new Error("Adhoc order already created for this order");
      }

      // Find all items with "Ordered" status
      const orderedItems = order.items.filter(
        (item) => item.orderStatus === OrderStatus.ORDERED.value
      );
      if (orderedItems.length === 0) {
        throw new Error("No items available for shipping in this order");
      }

      try {
        // Prepare ShipRocket order data
        const shiprocketOrderData = prepareShiprocketOrderData(
          order,
          order.user,
          {
            length,
            breadth,
            height,
            weight,
            address,
          }
        );

        // Create ShipRocket order
        const shiprocketResponse = await createAdhocOrder(
          shiprocketOrderData,
          token
        );
        if (!shiprocketResponse.success) {
          throw new Error(
            `Failed to create ShipRocket order: ${shiprocketResponse.error}`
          );
        }

        // Update shiprocket data for all ordered items
        const updatedShiprocketData = updateOrderWithShiprocketData(shiprocketResponse.data);
        console.log('[DEBUG] Shiprocket response data:', shiprocketResponse.data);
        console.log('[DEBUG] Updated shiprocket data to merge:', updatedShiprocketData);

        // Add shiprocket data to all ordered items
        orderedItems.forEach((item, index) => {
          const itemIndex = order.items.findIndex(orderItem => orderItem._id.toString() === item._id.toString());
          if (itemIndex !== -1) {
            if (!order.items[itemIndex].shiprocket) {
              order.items[itemIndex].shiprocket = {};
            }
            order.items[itemIndex].shiprocket = {
              ...order.items[itemIndex].shiprocket,
              ...updatedShiprocketData,
              flags: {
                ...order.items[itemIndex].shiprocket.flags,
                adhocOrderCreated: true,
              },
            };
          }
        });

        console.log("Updated ordered items with shiprocket data");

        await order.save({ session });
      } catch (shiprocketError) {
        console.error(
          "Shiprocket adhoc order creation error:",
          shiprocketError
        );
        throw new Error(
          `Failed to create adhoc order: ${shiprocketError.message}`
        );
      }
    });

    // Get shiprocket data from first ordered item
    const firstOrderedItem = order.items.find(item => item.orderStatus === OrderStatus.ORDERED.value);
    const shiprocketData = firstOrderedItem?.shiprocket || {};

    return res.status(200).json({
      success: true,
      message: "Adhoc order created successfully",
      data: {
        orderId: shiprocketData.orderId,
        shipmentId: shiprocketData.shipmentId,
      },
    });
  } catch (error) {
    console.error("Create Adhoc Order Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Step 2: Assign AWB to Shiprocket order
 * POST /api/admin/newOrders/:orderId/assign-awb
 */
export const assignAWBStep = async (req, res) => {
  try {
    const { orderId } = req.params;
    const token = req.shiprocketToken;

    console.debug("[assignAWBStep] orderId:", orderId, "token:", !!token);

    // Validate Shiprocket token
    if (!token) {
      console.debug("[assignAWBStep] Shiprocket token missing");
      return res
        .status(400)
        .json({ success: false, message: "Shiprocket token required" });
    }

    let order;

    await withTransaction(async (session) => {
      // Find order
      order = await Order.findOne({ orderId })
        .populate("user", "name email")
        .populate("items.product.productId", "name")
        .session(session);

      console.debug("[assignAWBStep] Fetched order:", order?.orderId);

      if (!order) {
        console.debug("[assignAWBStep] Order not found for orderId:", orderId);
        throw new Error("Order not found");
      }

      // Find ordered items with shiprocket data
      const orderedItemsWithShiprocket = order.items.filter(
        item => item.orderStatus === OrderStatus.ORDERED.value && item.shiprocket?.flags?.adhocOrderCreated
      );

      console.debug("[assignAWBStep] orderedItemsWithShiprocket:", orderedItemsWithShiprocket.map(i => i._id.toString()));

      if (orderedItemsWithShiprocket.length === 0) {
        console.debug("[assignAWBStep] No ordered items with adhoc order created found");
        throw new Error("No ordered items with adhoc order created found");
      }

      // Check if AWB already assigned to any ordered item
      const hasAWB = orderedItemsWithShiprocket.some(item => item.shiprocket?.flags?.awbAssigned);
      console.debug("[assignAWBStep] hasAWB:", hasAWB);

      if (hasAWB) {
        console.debug("[assignAWBStep] AWB already assigned on one of the items");
        throw new Error("AWB already assigned for this order");
      }

      try {
        // Get shipmentId from first ordered item
        const firstOrderedItem = orderedItemsWithShiprocket[0];
        const shipmentId = firstOrderedItem.shiprocket.shipmentId;

        console.debug("[assignAWBStep] shipmentId for assign:", shipmentId);

        // Assign AWB
        const awbResponse = await assignAWB(shipmentId, token);
        console.debug("[assignAWBStep] awbResponse:", awbResponse);

        if (!awbResponse.success) {
          console.debug("[assignAWBStep] Failed to assign AWB:", awbResponse.error);
          throw new Error(`Failed to assign AWB: ${awbResponse.error}`);
        }

        // Update AWB details for all ordered items with shiprocket data
        const awbData = updateOrderWithAWBData(order, awbResponse.data.response.data);
        console.debug("[assignAWBStep] AWB data after updateOrderWithAWBData:", awbData);

        orderedItemsWithShiprocket.forEach((item, index) => {
          const itemIndex = order.items.findIndex(orderItem => orderItem._id.toString() === item._id.toString());
          if (itemIndex !== -1) {
            order.items[itemIndex].shiprocket = {
              ...order.items[itemIndex].shiprocket,
              ...awbData,
              flags: {
                ...order.items[itemIndex].shiprocket.flags,
                awbAssigned: true,
              },
            };
            console.debug(`[assignAWBStep] Updated shiprocket for itemIndex ${itemIndex}`, order.items[itemIndex].shiprocket);
          }
        });

        const saveResult = await order.save({ session });
        console.debug("[assignAWBStep] Order save result:", !!saveResult);
      } catch (awbError) {
        console.error("Shiprocket AWB assignment error:", awbError);
        throw new Error(`Failed to assign AWB: ${awbError.message}`);
      }
    });

    // Get AWB data from first ordered item
    const firstOrderedItem = order.items.find(item => 
      item.orderStatus === OrderStatus.ORDERED.value && item.shiprocket?.flags?.awbAssigned
    );
    const shiprocketData = firstOrderedItem?.shiprocket || {};

    console.debug("[assignAWBStep] Returning shiprocketData:", shiprocketData);

    return res.status(200).json({
      success: true,
      message: "AWB assigned successfully",
      data: {
        trackingNumber: shiprocketData.trackingNumber,
        courierName: shiprocketData.courierName,
      },
    });
  } catch (error) {
    console.error("Assign AWB Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Step 3: Generate Pickup for Shiprocket order
 * POST /api/admin/newOrders/:orderId/generate-pickup
 */
export const generatePickupStep = async (req, res) => {
  try {
    const { orderId } = req.params;
    const token = req.shiprocketToken;

    console.debug("[generatePickupStep] orderId:", orderId, "token:", !!token);

    // Validate Shiprocket token
    if (!token) {
      console.debug("[generatePickupStep] Shiprocket token missing");
      return res
        .status(400)
        .json({ success: false, message: "Shiprocket token required" });
    }

    let order;

    await withTransaction(async (session) => {
      // Find order
      order = await Order.findOne({ orderId })
        .populate("user", "name email")
        .populate("items.product.productId", "name")
        .session(session);

      console.debug("[generatePickupStep] Fetched order:", order?.orderId);

      if (!order) {
        console.debug("[generatePickupStep] Order not found for orderId:", orderId);
        throw new Error("Order not found");
      }

      // Find ordered items with AWB assigned
      const orderedItemsWithAWB = order.items.filter(
        item => item.orderStatus === OrderStatus.ORDERED.value && item.shiprocket?.flags?.awbAssigned
      );

      console.debug("[generatePickupStep] orderedItemsWithAWB:", orderedItemsWithAWB.map(i => i._id.toString()));

      if (orderedItemsWithAWB.length === 0) {
        console.debug("[generatePickupStep] No ordered items with AWB assigned found");
        throw new Error("No ordered items with AWB assigned found");
      }

      // Check if pickup already generated for any ordered item
      const hasPickup = orderedItemsWithAWB.some(item => item.shiprocket?.flags?.pickupGenerated);
      console.debug("[generatePickupStep] hasPickup:", hasPickup);

      if (hasPickup) {
        console.debug("[generatePickupStep] Pickup already generated on one of the items");
        throw new Error("Pickup already generated for this order");
      }

      try {
        // Get shipmentId from first ordered item
        const firstOrderedItem = orderedItemsWithAWB[0];
        const shipmentId = firstOrderedItem.shiprocket.shipmentId;

        console.debug("[generatePickupStep] shipmentId for pickup:", shipmentId);

        // Generate pickup
        const pickupResponse = await generatePickup(shipmentId, token);
        console.debug("[generatePickupStep] pickupResponse:", pickupResponse);

        if (!pickupResponse.success) {
          console.debug("[generatePickupStep] Failed to generate pickup:", pickupResponse.error);
          throw new Error(`Failed to generate pickup: ${pickupResponse.error}`);
        }

        // Update pickup flags for all ordered items with AWB
        orderedItemsWithAWB.forEach((item, index) => {
          const itemIndex = order.items.findIndex(orderItem => orderItem._id.toString() === item._id.toString());
          if (itemIndex !== -1) {
            order.items[itemIndex].shiprocket = {
              ...order.items[itemIndex].shiprocket,
              flags: {
                ...order.items[itemIndex].shiprocket.flags,
                pickupGenerated: true,
              },
            };
            console.debug(`[generatePickupStep] Updated pickupGenerated for itemIndex ${itemIndex}`, order.items[itemIndex].shiprocket.flags);
          }
        });

        // Mark all ordered items as shipped after all steps are complete
        const historyEntry = createStatusHistoryEntry(
          OrderStatus.SHIPPED.value,
          "Order shipped via Shiprocket - All steps completed"
        );

        let shippedItemsCount = 0;
        order.items.forEach((item) => {
          if (item.orderStatus === OrderStatus.ORDERED.value) {
            item.orderStatus = OrderStatus.SHIPPED.value;
            item.statusHistory.push(historyEntry);
            item.shippedAt = new Date();

            // Add Shiprocket data to each item
            item.shiprocket = {
              orderId: order.shiprocket?.orderId,
              shipmentId: order.shiprocket?.shipmentId,
              trackingNumber: order.shiprocket?.trackingNumber,
              courierName: order.shiprocket?.courierName,
            };
            shippedItemsCount++;
          }
        });

        console.debug("[generatePickupStep] shippedItemsCount after marking as shipped:", shippedItemsCount);

        const saveResult = await order.save({ session });
        console.debug("[generatePickupStep] Order save result:", !!saveResult);
      } catch (pickupError) {
        console.error("Shiprocket pickup generation error:", pickupError);
        throw new Error(`Failed to generate pickup: ${pickupError.message}`);
      }
    });

    // Get shiprocket data from first ordered item
    const firstOrderedItem = order.items.find(item => 
      item.orderStatus === OrderStatus.ORDERED.value && item.shiprocket?.flags?.pickupGenerated
    );
    const shiprocketData = firstOrderedItem?.shiprocket || {};

    console.debug("[generatePickupStep] Returning shiprocketData:", shiprocketData);

    return res.status(200).json({
      success: true,
      message: "Pickup generated successfully and order marked as shipped",
      data: {
        pickupGenerated: shiprocketData.flags?.pickupGenerated,
        shippedItemsCount: order.items.filter(
          (item) => item.orderStatus === OrderStatus.SHIPPED.value
        ).length,
        trackingInfo: {
          trackingNumber: shiprocketData.trackingNumber,
          courierName: shiprocketData.courierName,
          shipmentId: shiprocketData.shipmentId,
        },
      },
    });
  } catch (error) {
    console.error("Generate Pickup Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Cancel Order Item
 * POST /api/newOrders/items/cancel
 */

export const cancelOrderItem = async (req, res) => {
  const { itemId, quantity } = req.body;

  if (!itemId || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ success: false, message: "Invalid request" });
  }

  try {
    await withTransaction(async (session) => {
      const order = await Order.findOne({
        "items._id": itemId,
        user: req.user,
      }).session(session);
      if (!order) throw new Error("Item not found");

      const itemIndex = order.items.findIndex(
        (i) => i._id.toString() === itemId
      );
      if (itemIndex === -1) throw new Error("Item not found in order");

      const item = order.items[itemIndex];

      if (!canTransition(item.orderStatus, OrderStatus.CANCELLED.value)) {
        throw new Error(`Cannot cancel item from status: ${item.orderStatus}`);
      }

      if (quantity > item.quantity) {
        throw new Error("Cancel quantity exceeds ordered quantity");
      }

      const historyEntry = {
        status: OrderStatus.CANCELLED.value,
        note: "Cancelled by user",
        changedAt: new Date(),
      };

      if (quantity < item.quantity) {
        // Partial cancellation → split into a new cancelled item
        const cancelledBatch = item.toObject({ depopulate: true });
        delete cancelledBatch._id;
        cancelledBatch.quantity = quantity;
        cancelledBatch.orderStatus = OrderStatus.CANCELLED.value;
        cancelledBatch.statusHistory = [
          ...cancelledBatch.statusHistory,
          historyEntry,
        ];

        item.quantity -= quantity;
        order.items.push(cancelledBatch);
      } else {
        // Full item cancellation
        item.orderStatus = OrderStatus.CANCELLED.value;
        item.statusHistory.push(historyEntry);
      }

      await order.save({ session });
    });

    return res
      .status(200)
      .json({ success: true, message: "Item(s) cancelled successfully" });
  } catch (err) {
    console.error("Cancel Order Error:", err);
    return res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
};


/**
 * Cancel Order Item
 * POST /api/admin/newOrders/items/cancel
 */

export const cancelOrderItemByAdmin = async (req, res) => {
  const { itemId, quantity, note, userId } = req.body;

  if (!itemId || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ success: false, message: "Invalid request" });
  }

  try {
    await withTransaction(async (session) => {
      const order = await Order.findOne({
        "items._id": itemId,
        user: userId,
      }).session(session);
      if (!order) throw new Error("Item not found");

      const itemIndex = order.items.findIndex(
        (i) => i._id.toString() === itemId
      );
      if (itemIndex === -1) throw new Error("Item not found in order");

      const item = order.items[itemIndex];

      if (!canTransition(item.orderStatus, OrderStatus.CANCELLED.value)) {
        throw new Error(`Cannot cancel item from status: ${item.orderStatus}`);
      }

      if (quantity > item.quantity) {
        throw new Error("Cancel quantity exceeds ordered quantity");
      }

      const historyEntry = {
        status: OrderStatus.CANCELLED.value,
        note: note,
        changedAt: new Date(),
      };

      if (quantity < item.quantity) {
        // Partial cancellation → split into a new cancelled item
        const cancelledBatch = item.toObject({ depopulate: true });
        delete cancelledBatch._id;
        cancelledBatch.quantity = quantity;
        cancelledBatch.orderStatus = OrderStatus.CANCELLED.value;
        cancelledBatch.statusHistory = [
          ...cancelledBatch.statusHistory,
          historyEntry,
        ];

        item.quantity -= quantity;
        order.items.push(cancelledBatch);
      } else {
        // Full item cancellation
        item.orderStatus = OrderStatus.CANCELLED.value;
        item.statusHistory.push(historyEntry);
      }

      await order.save({ session });
    });

    return res
      .status(200)
      .json({ success: true, message: "Item(s) cancelled successfully" });
  } catch (err) {
    console.error("Cancel Order Error:", err);
    return res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
};

/**
 * Return Order Item
 * POST /api/admin/newOrders/items/return
 */
export const returnOrderItem = async (req, res) => {
  const { itemId, quantity, note } = req.body;

  if (!itemId || !Number.isInteger(quantity) || quantity < 1) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid item or quantity" });
  }
  if (!note || typeof note !== "string") {
    return res
      .status(400)
      .json({ success: false, message: "Return note is required" });
  }

  try {
    await withTransaction(async (session) => {
      const order = await Order.findOne({
        "items._id": itemId,
        user: req.user,
      }).session(session);
      if (!order) throw new Error("Item not found");

      const itemIndex = order.items.findIndex(
        (i) => i._id.toString() === itemId
      );
      if (itemIndex === -1) throw new Error("Item not found in order");

      const item = order.items[itemIndex];

      if (
        !canTransition(item.orderStatus, OrderStatus.RETURN_REQUESTED.value)
      ) {
        throw new Error(`Cannot return item with status: ${item.orderStatus}`);
      }

      if (quantity > item.quantity) {
        throw new Error("Return quantity exceeds ordered quantity");
      }

      const deliveredEntry = item.statusHistory.find(
        (s) => s.status === OrderStatus.DELIVERED.value
      );
      if (!deliveredEntry?.changedAt) {
        throw new Error("Delivery date missing in history");
      }

      const daysPassed = Math.floor(
        (new Date().setHours(0, 0, 0, 0) -
          new Date(deliveredEntry.changedAt).setHours(0, 0, 0, 0)) /
          (1000 * 60 * 60 * 24)
      );
      if (daysPassed > 7) {
        throw new Error(
          `Return window expired (${daysPassed} days since delivery)`
        );
      }

      let returnId;
      do {
        returnId = generateReturnId();
      } while (
        await Order.exists({ "items.returnId": returnId }).session(session)
      );

      const historyEntry = {
        status: OrderStatus.RETURN_REQUESTED.value,
        note,
        changedAt: new Date(),
      };

      if (quantity < item.quantity) {
        const returnedBatch = item.toObject({ depopulate: true });
        delete returnedBatch._id;
        returnedBatch.quantity = quantity;
        returnedBatch.orderStatus = OrderStatus.RETURN_REQUESTED.value;
        returnedBatch.returnId = returnId;
        returnedBatch.returnRequestedAt = new Date();
        returnedBatch.returnRequestNote = note;
        returnedBatch.statusHistory = [
          ...returnedBatch.statusHistory,
          historyEntry,
        ];

        item.quantity -= quantity;
        order.items.push(returnedBatch);
      } else {
        item.orderStatus = OrderStatus.RETURN_REQUESTED.value;
        item.returnId = returnId;
        item.returnRequestedAt = new Date();
        item.returnRequestNote = note;
        item.statusHistory.push(historyEntry);
      }

      await order.save({ session });
    });

    return res
      .status(200)
      .json({ success: true, message: "Return request placed successfully" });
  } catch (err) {
    console.error("Return Order Error:", err);
    return res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
};

/**
 * Mark item as departed for return
 * POST /api/admin/newOrders/items/:itemId/mark-departed-for-return
 */
export const markItemAsDepartedForReturn = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { items = [], note = "", package: { length, breadth, height, weight } } = req.body;
    const token = req.shiprocketToken;

    // Validate input parameters
    if (!orderId) {
      return res
        .status(400)
        .json({ success: false, message: "Order information is missing. Please try again." });
    }

    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "Unable to process return. Please contact support." });
    }

    if (!length || !breadth || !height || !weight) {
      return res
        .status(400)
        .json({ success: false, message: "Package dimensions are required. Please try again." });
    }

    // Validate items array
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      !items.every(
        (entry) =>
          entry &&
          typeof entry.itemId === "string" &&
          typeof entry.quantity === "number" &&
          entry.quantity > 0
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Please select valid items with correct quantities to process the return."
      });
    }

    await withTransaction(async (session) => {
      // Find the order
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        throw new Error("Order not found. Please check the order details and try again.");
      }

      // Get items in the order matching input IDs that are in return requested status
      const requestedItemIds = new Set(items.map((entry) => entry.itemId));
      const itemsInOrder = order.items.filter(
        (item) =>
          requestedItemIds.has(item._id.toString()) &&
          item.orderStatus === OrderStatus.RETURN_REQUESTED.value
      );

      if (itemsInOrder.length === 0) {
        throw new Error("No items are currently eligible for return departure. All items must be in 'Return Requested' status first.");
      }

      if (itemsInOrder.length !== items.length) {
        throw new Error("Not all selected items are ready for return departure. Please ensure all items are in 'Return Requested' status before marking them as departed for return.");
      }

      // Process each item
      const processedItems = [];
      for (const item of itemsInOrder) {
        const requestedItem = items.find(entry => entry.itemId === item._id.toString());
        const { quantity } = requestedItem;

        // Validate status transition
        if (
          !canTransition(
            item.orderStatus,
            OrderStatus.DEPARTED_FOR_RETURNING.value
          )
        ) {
          throw new Error(
            `This item cannot be marked as departed for return at this time. Please ensure the item is in the correct status.`
          );
        }

        // Validate quantity
        if (quantity > item.quantity) {
          throw new Error(
            `The requested return quantity (${quantity}) is more than what's available (${item.quantity}). Please check the quantities and try again.`
          );
        }

        const historyEntry = createStatusHistoryEntry(
          OrderStatus.DEPARTED_FOR_RETURNING.value,
          note || "Item departed for return"
        );

        if (quantity < item.quantity) {
          // Partial return departure - create new item for departed portion
          const departedBatch = item.toObject({ depopulate: true });
          delete departedBatch._id;
          departedBatch.quantity = quantity;
          departedBatch.orderStatus = OrderStatus.DEPARTED_FOR_RETURNING.value;
          departedBatch.statusHistory = [
            ...departedBatch.statusHistory,
            historyEntry,
          ];
          departedBatch.returnDepartedAt = new Date();

          // Reduce quantity of original item
          item.quantity -= quantity;

          // Add new departed item to order
          order.items.push(departedBatch);
          processedItems.push(departedBatch);
        } else {
          // Full return departure - update existing item
          item.orderStatus = OrderStatus.DEPARTED_FOR_RETURNING.value;
          item.statusHistory.push(historyEntry);
          item.returnDepartedAt = new Date();
          processedItems.push(item);
        }
      }

      // Wrap ShipRocket call + mutations in another withTransaction for extra safety/atomicity if desired
      await withTransaction(async (srSession) => {
        try {
          const shiprocketResponse = await createShiprocketReturnOrder(
            order,
            processedItems,
            { length, breadth, height, weight },
            token
          );

          if (shiprocketResponse?.success && shiprocketResponse.data) {
            if (!order.shiprocket) {
              order.shiprocket = {};
            }
            order.shiprocket = updateOrderWithReturnData(order, shiprocketResponse.data);

            processedItems.forEach((item) => {
              if (!item.shiprocket) {
                item.shiprocket = {};
              }
              item.shiprocket = {
                ...item.shiprocket,
                returnOrderId: shiprocketResponse.data.order_id || shiprocketResponse.data.return_order_id,
                returnShipmentId: shiprocketResponse.data.shipment_id || shiprocketResponse.data.return_shipment_id,
                returnTrackingNumber: shiprocketResponse.data.tracking_number || shiprocketResponse.data.return_tracking_number,
                returnAwbCode: shiprocketResponse.data.awb_code,
                returnCourierId: shiprocketResponse.data.courier_id,
                returnCourierName: shiprocketResponse.data.courier_name,
              };
            });

            console.log("ShipRocket return order created successfully:", {
              returnOrderId: shiprocketResponse.data.order_id,
              returnShipmentId: shiprocketResponse.data.shipment_id,
              returnTrackingNumber: shiprocketResponse.data.tracking_number
            });
          } else {
            console.warn("ShipRocket return order creation failed:", shiprocketResponse?.error || "Unknown error");
          }
        } catch (shiprocketError) {
          console.error("ShipRocket return order creation error:", shiprocketError);
          // Don't fail the order update if ShipRocket fails
          // Log the error but continue with the order update
        }
      });

      await order.save({ session });
    });

    return res.status(200).json({
      success: true,
      message: `Successfully marked ${items.length} item(s) as departed for return. The return process has been initiated.`,
      data: {
        processedItems: items.length,
        returnStatus: "Departed For Returning",
        nextSteps: "Items are now in transit for return. Tracking information will be available once the courier picks up the items."
      }
    });
  } catch (error) {
    console.error("Mark Item Departed for Return Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to process the return at this time. Please try again later or contact support if the issue persists."
    });
  }
};


// POST /admin/items/:itemId/return-cancel
export const processReturnCancelByAdmin = async (req, res) => {
  const { itemId, quantity } = req.body; // quantity optional — defaults to full batch

  if (!itemId) {
    return res
      .status(400)
      .json({ success: false, message: "itemId is required" });
  }

  try {
    await withTransaction(async (session) => {
      const order = await Order.findOne({ "items._id": itemId }).session(
        session
      );
      if (!order) throw new Error("Item not found");

      const itemIndex = order.items.findIndex(
        (i) => i._id.toString() === itemId
      );
      const item = order.items[itemIndex];
      if (!item) throw new Error("Item not found in order");

      // Default to full quantity if not provided
      const cancelQty = quantity && quantity > 0 ? quantity : item.quantity;

      if (cancelQty > item.quantity)
        throw new Error("Cancel quantity exceeds available quantity");

      // Validate status transition
      if (
        !canTransition(item.orderStatus, OrderStatus.RETURN_CANCELLED.value)
      ) {
        throw new Error(`Cannot cancel return at status: ${item.orderStatus}`);
      }

      // Handle partial quantity
      if (cancelQty < item.quantity) {
        const cancelledBatch = {
          ...item.toObject(),
          quantity: cancelQty,
          orderStatus: OrderStatus.RETURN_CANCELLED.value,
          statusHistory: [
            ...item.statusHistory,
            {
              status: OrderStatus.RETURN_CANCELLED.value,
              note: "Return request cancelled by admin",
              changedAt: new Date(),
            },
          ],
          returnCancelledAt: new Date(),
        };

        // Reduce original batch quantity
        item.quantity -= cancelQty;

        // Push the new cancelled batch
        order.items.push(cancelledBatch);
      } else {
        // Full batch change
        item.orderStatus = OrderStatus.RETURN_CANCELLED.value;
        item.returnCancelledAt = new Date();
        item.statusHistory.push({
          status: OrderStatus.RETURN_CANCELLED.value,
          note: "Return request cancelled by admin",
          changedAt: new Date(),
        });
      }

      await order.save({ session });
    });

    return res.status(200).json({
      success: true,
      message: "Return request cancelled successfully",
    });
  } catch (err) {
    console.error("processReturnCancel error:", err);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

export const processReturnCancel = async (req, res) => {
  const { itemId, quantity } = req.body; // quantity optional — defaults to full batch
  const userId = req.user;

  if (!userId) {
    return res
      .status(400)
      .json({ success: false, message: "Unauthorized" });
  }

  if (!itemId) {
    return res
      .status(400)
      .json({ success: false, message: "Select the product to cancel return" });
  }

  try {
    await withTransaction(async (session) => {
      const order = await Order.findOne({ "items._id": itemId, user: userId }).session(
        session
      );
      if (!order) throw new Error("Item not found");

      const itemIndex = order.items.findIndex(
        (i) => i._id.toString() === itemId
      );
      const item = order.items[itemIndex];
      if (!item) throw new Error("Item not found in order");

      // Default to full quantity if not provided
      const cancelQty = quantity && quantity > 0 ? quantity : item.quantity;

      if (cancelQty > item.quantity)
        throw new Error("Cancel quantity exceeds available quantity");

      // Validate status transition
      if (
        !canTransition(item.orderStatus, OrderStatus.RETURN_CANCELLED.value)
      ) {
        throw new Error(`Cannot cancel return at status: ${item.orderStatus}`);
      }

      // Handle partial quantity
      if (cancelQty < item.quantity) {
        const cancelledBatch = {
          ...item.toObject(),
          quantity: cancelQty,
          orderStatus: OrderStatus.RETURN_CANCELLED.value,
          statusHistory: [
            ...item.statusHistory,
            {
              status: OrderStatus.RETURN_CANCELLED.value,
              note: "Return request cancelled by admin",
              changedAt: new Date(),
            },
          ],
          returnCancelledAt: new Date(),
        };

        // Reduce original batch quantity
        item.quantity -= cancelQty;

        // Push the new cancelled batch
        order.items.push(cancelledBatch);
      } else {
        // Full batch change
        item.orderStatus = OrderStatus.RETURN_CANCELLED.value;
        item.returnCancelledAt = new Date();
        item.statusHistory.push({
          status: OrderStatus.RETURN_CANCELLED.value,
          note: "Return request cancelled by admin",
          changedAt: new Date(),
        });
      }

      await order.save({ session });
    });

    return res.status(200).json({
      success: true,
      message: "Return request cancelled successfully",
    });
  } catch (err) {
    console.error("processReturnCancel error:", err);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/**
 * Manual Status Update for Admin
 * POST /api/admin/newOrders/items/:itemId/update-status
 * Allows admin to manually update order item status with proper validation.
 * 
 * IMPORTANT: Only forward transitions are allowed (e.g., Ordered → Shipped → Delivered).
 * Backward transitions are strictly prohibited (e.g., Shipped → Ordered is not allowed).
 * This ensures order status integrity and prevents data inconsistencies.
 */
export const updateOrderItemStatus = async (req, res) => {
  const { itemId } = req.params;
  const { status, note = "", quantity } = req.body;

  // Validation
  if (!itemId) {
    return res.status(400).json({
      success: false,
      message: "Item ID is required"
    });
  }

  if (!status) {
    return res.status(400).json({
      success: false,
      message: "Status is required"
    });
  }

  // Validate status is a valid OrderStatus
  const validStatuses = Object.values(OrderStatus).map(s => s.value);
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Valid statuses are: ${validStatuses.join(", ")}`
    });
  }

  // Store currentStatus outside transaction for use in response
  let currentStatus = null;

  try {
    await withTransaction(async (session) => {
      // Find the order containing this item
      const order = await Order.findOne({ "items._id": itemId }).session(session);
      if (!order) {
        throw new Error("Order item not found");
      }

      // Find the specific item
      const itemIndex = order.items.findIndex(
        (item) => item._id.toString() === itemId
      );
      
      if (itemIndex === -1) {
        throw new Error("Item not found in order");
      }

      const item = order.items[itemIndex];
      currentStatus = item.orderStatus; // Store outside transaction scope

      // Validate status transition (forward-only, no backward transitions)
      if (!canTransition(currentStatus, status)) {
        const availableTransitions = statusMap[currentStatus] || [];
        throw new Error(
          `Invalid status transition: Cannot change from "${currentStatus}" to "${status}". ` +
          `Only forward transitions are allowed. ` +
          `Available next statuses: ${availableTransitions.length > 0 ? availableTransitions.join(", ") : "None (final status)"}`
        );
      }

      // Handle quantity if provided (for partial updates)
      const updateQuantity = quantity && quantity > 0 ? quantity : item.quantity;
      
      if (updateQuantity > item.quantity) {
        throw new Error("Update quantity exceeds item quantity");
      }

      // Create status history entry
      const historyEntry = createStatusHistoryEntry(
        status,
        note || `Status updated from ${currentStatus} to ${status} by admin`
      );

      if (updateQuantity < item.quantity) {
        // Partial update - split the item
        const updatedBatch = item.toObject({ depopulate: true });
        delete updatedBatch._id;
        
        updatedBatch.quantity = updateQuantity;
        updatedBatch.orderStatus = status;
        updatedBatch.statusHistory = [...updatedBatch.statusHistory, historyEntry];
        
        // Set specific timestamps based on status
        if (status === OrderStatus.SHIPPED.value) {
          updatedBatch.shippedAt = new Date();
        } else if (status === OrderStatus.DELIVERED.value) {
          updatedBatch.deliveredAt = new Date();
        } else if (status === OrderStatus.CANCELLED.value) {
          updatedBatch.cancelledAt = new Date();
        } else if (status === OrderStatus.RETURN_REQUESTED.value) {
          updatedBatch.returnRequestedAt = new Date();
          updatedBatch.returnId = generateReturnId();
        } else if (status === OrderStatus.RETURNED.value) {
          updatedBatch.returnedAt = new Date();
        }

        // Reduce original item quantity
        item.quantity -= updateQuantity;
        
        // Add the new batch
        order.items.push(updatedBatch);
      } else {
        // Full update - modify existing item
        item.orderStatus = status;
        item.statusHistory.push(historyEntry);
        
        // Set specific timestamps based on status
        if (status === OrderStatus.SHIPPED.value) {
          item.shippedAt = new Date();
        } else if (status === OrderStatus.DELIVERED.value) {
          item.deliveredAt = new Date();
        } else if (status === OrderStatus.CANCELLED.value) {
          item.cancelledAt = new Date();
        } else if (status === OrderStatus.RETURN_REQUESTED.value) {
          item.returnRequestedAt = new Date();
          item.returnId = generateReturnId();
        } else if (status === OrderStatus.RETURNED.value) {
          item.returnedAt = new Date();
        }
      }

      // Save order with updated status
      // This update will be immediately visible to users when they fetch their orders
      await order.save({ session });
    });

    // Transaction completed successfully - status update is now in database
    // User endpoints (getUserOrders, getOrderByOrderId) will automatically reflect this change
    // as they query the database directly with .lean()
    
    // Use currentStatus in response (now accessible outside transaction)
    return res.status(200).json({
      success: true,
      message: `Order item status updated successfully to ${status}`,
      data: {
        itemId,
        newStatus: status,
        previousStatus: currentStatus,
        note: note || `Status updated from ${currentStatus} to ${status} by admin`
      }
    });

  } catch (err) {
    console.error("Update Order Item Status Error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update order item status"
    });
  }
};

/**
 * Get Available Status Transitions for an Item
 * GET /api/admin/newOrders/items/:itemId/available-transitions
 * Returns the possible status transitions for a specific order item.
 * 
 * NOTE: Only forward transitions are returned. Backward transitions are not available
 * to maintain order status integrity (e.g., once Shipped, cannot go back to Ordered).
 */
export const getAvailableStatusTransitions = async (req, res) => {
  const { itemId } = req.params;

  if (!itemId) {
    return res.status(400).json({
      success: false,
      message: "Item ID is required"
    });
  }

  try {
    const order = await Order.findOne({ "items._id": itemId });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order item not found"
      });
    }

    const item = order.items.find(item => item._id.toString() === itemId);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Item not found in order"
      });
    }

    const currentStatus = item.orderStatus;
    const availableTransitions = statusMap[currentStatus] || [];

    // Get status details for available transitions (forward-only)
    const transitionDetails = availableTransitions.map(statusValue => {
      const statusObj = Object.values(OrderStatus).find(s => s.value === statusValue);
      return {
        value: statusValue,
        label: statusValue, // Use the value as label since OrderStatus doesn't have label property
        description: `Move forward from ${currentStatus} to ${statusValue}`
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        currentStatus: {
          value: currentStatus,
          label: Object.values(OrderStatus).find(s => s.value === currentStatus)?.label || currentStatus
        },
        availableTransitions: transitionDetails,
        itemDetails: {
          productName: item.product.name,
          size: item.size,
          color: item.color.name,
          quantity: item.quantity
        }
      }
    });

  } catch (err) {
    console.error("Get Available Transitions Error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to get available transitions"
    });
  }
};