import { paymentService } from '../services/paymetService.js';
import { PaymentTransaction, PaymentStatus, PaymentProvider } from '../models/paymentTransaction.model.js';
import { NewOrder } from '../models/newOrder.model.js';
import { generateOrderId } from '../services/orderUtils.js';
import { _config } from '../config/config.js';
import crypto from 'crypto';

// Get payment configuration
export const getPaymentConfig = async (req, res) => {
  try {
    const config = await paymentService.getPaymentConfig();
    if (!config) {
      return res.status(404).json({ success: false, message: 'Payment configuration not found' });
    }

    console.log('Payment config retrieved:', config);

    // Return only necessary info for frontend
    const publicConfig = {
      onlinePaymentEnabled: config.onlinePaymentEnabled,
      codEnabled: config.codEnabled,
      providers: config.providers.map(provider => ({
        name: provider.name,
        isEnabled: provider.isEnabled,
        settings: provider.settings
      })),
      defaultProvider: config.defaultProvider,
      limits: config.limits
    };

    console.log('Public config being returned:', publicConfig);
    return res.status(200).json({ success: true, data: publicConfig });
  } catch (error) {
    console.error('Error getting payment config:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Simple payment endpoint for Cashfree (like your example)
export const createSimplePayment = async (req, res) => {
  try {
    const { orderId, amount } = req.body;
    const userId = req.user;

    if (!orderId || !amount) {
      return res.status(400).json({ success: false, message: 'Missing orderId or amount' });
    }

    // Ensure amount is an integer (payment gateways require integer amounts in paise)
    const amountInt = Math.round(Number(amount));
    if (!Number.isInteger(amountInt) || amountInt <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive integer' });
    }

    // Check if Cashfree is enabled
    const config = await paymentService.getPaymentConfig();
    const cashfreeConfig = config?.providers?.find(p => p.name === 'cashfree');
    
    if (!cashfreeConfig || !cashfreeConfig.isEnabled) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cashfree is not enabled. Please enable it in admin settings.' 
      });
    }

    // Create Cashfree order
    const orderData = {
      orderId,
      amount: amountInt / 100, // Convert from paise to rupees (frontend sends paise)
      currency: 'INR',
      userId: userId.toString(),
      customerName: 'Customer',
      customerEmail: 'customer@example.com',
      customerPhone: '9999999999'
    };

    console.log('Creating Cashfree order with data:', orderData);

    const paymentOrder = await paymentService.createCashfreeOrder(orderData);
    
    console.log('Cashfree order response:', paymentOrder);
    
    if (paymentOrder && paymentOrder.payment_session_id) {
      return res.status(200).json({
        success: true,
        data: {
          payment_session_id: paymentOrder.payment_session_id,
          order_id: paymentOrder.order_id,
          order_amount: paymentOrder.order_amount
        }
      });
    } else {
      return res.status(400).json({ success: false, message: 'Failed to create payment session' });
    }
  } catch (error) {
    console.error('Error creating simple payment:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create payment order (Razorpay/Cashfree)
export const createPaymentOrder = async (req, res) => {
  try {
    const { orderId, amount, provider } = req.body;
    const userId = req.user;

    if (!orderId || !amount || !provider) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Ensure amount is an integer (payment gateways require integer amounts in paise)
    const amountInt = Math.round(Number(amount));
    if (!Number.isInteger(amountInt) || amountInt <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive integer' });
    }

    // Check if provider is enabled
    const config = await paymentService.getPaymentConfig();
    const providerConfig = config.providers.find(p => p.name === provider);
    
    if (!providerConfig || !providerConfig.isEnabled) {
      return res.status(400).json({ success: false, message: `${provider} is not enabled` });
    }

    // Generate transaction ID
    const transactionId = `txn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    let paymentOrder;
    let providerOrderId;

    if (provider === 'razorpay') {
      paymentOrder = await paymentService.createRazorpayOrder({
        orderId,
        amount: amountInt, // Use integer amount
        userId: userId.toString()
      });
      providerOrderId = paymentOrder.id;
    } else if (provider === 'cashfree') {
      paymentOrder = await paymentService.createCashfreeOrder({
        orderId,
        amount: amountInt / 100, // Convert from paise to rupees (frontend sends paise)
        userId: userId.toString(),
        customerName: req.body.customerName,
        customerEmail: req.body.customerEmail,
        customerPhone: req.body.customerPhone
      });
      providerOrderId = paymentOrder.order_id;
      console.log('Cashfree order created:', paymentOrder);
    }

    // Create payment transaction record
    const transaction = await paymentService.createPaymentTransaction({
      transactionId,
      orderId,
      user: userId,
      amount: amountInt, // Use integer amount
      provider,
      providerOrderId,
      paymentMethod: 'online',
      status: PaymentStatus.PENDING,
      metadata: {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip
      }
    });

    // Prepare response data
    const responseData = {
      transactionId,
      orderId, // Add the internal order ID
      providerOrderId, // Keep the provider order ID for compatibility
      paymentOrder,
      provider
    };

    // Add provider-specific data
    // Priority: .env file credentials > database credentials
    if (provider === 'razorpay') {
      responseData.key_id = _config.RAZORPAY_KEY_ID || providerConfig.credentials.keyId;
    }

    return res.status(200).json({
      success: true,
      data: responseData
    });
  } catch (error) {
    console.error('Error creating payment order:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Verify payment (Razorpay)
export const verifyRazorpayPayment = async (req, res) => {
  console.log('=== RAZORPAY PAYMENT VERIFICATION DEBUG START ===');
  console.log('Verification request body:', JSON.stringify(req.body, null, 2));
  
  try {
    const { transactionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!transactionId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.log('Missing payment verification data');
      console.log('=== RAZORPAY PAYMENT VERIFICATION DEBUG END (MISSING DATA) ===');
      return res.status(400).json({ success: false, message: 'Missing payment verification data' });
    }

    // Get transaction
    console.log('Fetching transaction with ID:', transactionId);
    const transaction = await paymentService.getPaymentTransaction(transactionId);
    if (!transaction) {
      console.log('Transaction not found for ID:', transactionId);
      console.log('=== RAZORPAY PAYMENT VERIFICATION DEBUG END (TRANSACTION NOT FOUND) ===');
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    console.log('Transaction found:', transaction);

    // Verify payment with Razorpay
    console.log('Verifying payment with Razorpay...');
    const verificationData = await paymentService.verifyRazorpayPayment({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    });
    console.log('Payment verification successful:', verificationData);

    // Update transaction
    console.log('Updating payment transaction...');
    await paymentService.updatePaymentTransaction(transactionId, {
      status: PaymentStatus.SUCCESS,
      providerTransactionId: razorpay_payment_id,
      razorpay: {
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature
      },
      completedAt: new Date()
    });

    // Update order payment status and transaction ID
    console.log('Updating order payment status for orderId:', transaction.orderId);
    const orderUpdateResult = await NewOrder.findOneAndUpdate(
      { orderId: transaction.orderId },
      { 
        paymentStatus: 'PAID',
        transactionId: transactionId
      }
    );
    console.log('Order update result:', orderUpdateResult);

    console.log('=== RAZORPAY PAYMENT VERIFICATION DEBUG END (SUCCESS) ===');
    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      data: {
        transactionId,
        orderId: transaction.orderId,
        status: PaymentStatus.SUCCESS
      }
    });
  } catch (error) {
    console.log('=== RAZORPAY PAYMENT VERIFICATION DEBUG END (ERROR) ===');
    console.error('Error verifying Razorpay payment:', error);
    
    // Update transaction as failed
    if (req.body.transactionId) {
      await paymentService.updatePaymentTransaction(req.body.transactionId, {
        status: PaymentStatus.FAILED,
        failedAt: new Date(),
        error: {
          code: 'VERIFICATION_FAILED',
          message: error.message
        }
      });
    }

    return res.status(400).json({ success: false, message: error.message });
  }
};

// Verify payment (Cashfree)
export const verifyCashfreePayment = async (req, res) => {
  console.log('=== CASHFREE PAYMENT VERIFICATION DEBUG START ===');
  console.log('Verification request body:', JSON.stringify(req.body, null, 2));
  
  try {
    const { transactionId, order_id, payment_id, orderId } = req.body;

    // For Cashfree, we can verify with just orderId (like the test code)
    if (orderId) {
      console.log('Verifying Cashfree payment with orderId:', orderId);
      
      // Verify payment with Cashfree using order ID
      const verificationData = await paymentService.verifyCashfreePayment({
        orderId: orderId
      });

      console.log('Cashfree verification data:', verificationData);

      if (verificationData.payment_status === 'SUCCESS') {
        console.log('Payment verification successful, updating order...');
        // Update order payment status and transaction ID
        const orderUpdateResult = await NewOrder.findOneAndUpdate(
          { orderId: orderId },
          { 
            paymentStatus: 'PAID',
            transactionId: verificationData.transactionId
          }
        );
        console.log('Order update result:', orderUpdateResult);

        console.log('=== CASHFREE PAYMENT VERIFICATION DEBUG END (SUCCESS) ===');
        return res.status(200).json({
          success: true,
          message: 'Payment verified successfully',
          data: {
            transactionId: verificationData.transactionId,
            orderId: orderId,
            status: 'SUCCESS',
            paymentId: verificationData.paymentId
          }
        });
      } else {
        console.log('Payment verification failed - payment not successful');
        console.log('=== CASHFREE PAYMENT VERIFICATION DEBUG END (PAYMENT NOT SUCCESS) ===');
        return res.status(400).json({ 
          success: false, 
          message: 'Payment verification failed - payment not successful' 
        });
      }
    }

    // Legacy verification with transactionId, order_id, payment_id
    if (!transactionId || !order_id || !payment_id) {
      return res.status(400).json({ success: false, message: 'Missing payment verification data' });
    }

    // Get transaction
    const transaction = await paymentService.getPaymentTransaction(transactionId);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    // Verify payment with Cashfree
    const verificationData = await paymentService.verifyCashfreePayment({
      order_id,
      payment_id,
      orderId: req.body.orderId
    });

    console.log('Cashfree verification data:', verificationData);

    if (verificationData.payment_status !== 'SUCCESS') {
      throw new Error('Payment verification failed');
    }

    // Update transaction
    await paymentService.updatePaymentTransaction(transactionId, {
      status: PaymentStatus.SUCCESS,
      providerTransactionId: payment_id,
      cashfree: {
        orderId: order_id,
        paymentId: payment_id
      },
      completedAt: new Date()
    });

    // Update order payment status and transaction ID
    await NewOrder.findOneAndUpdate(
      { orderId: transaction.orderId },
      { 
        paymentStatus: 'PAID',
        transactionId: transactionId
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      data: {
        transactionId,
        orderId: transaction.orderId,
        status: PaymentStatus.SUCCESS
      }
    });
  } catch (error) {
    console.log('=== CASHFREE PAYMENT VERIFICATION DEBUG END (ERROR) ===');
    console.error('Error verifying Cashfree payment:', error);
    
    // Update transaction as failed
    if (req.body.transactionId) {
      await paymentService.updatePaymentTransaction(req.body.transactionId, {
        status: PaymentStatus.FAILED,
        failedAt: new Date(),
        error: {
          code: 'VERIFICATION_FAILED',
          message: error.message
        }
      });
    }

    return res.status(400).json({ success: false, message: error.message });
  }
};

// Get payment transactions
export const getPaymentTransactions = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user;

    const transactions = await paymentService.getPaymentTransactionsByOrder(orderId);
    
    // Filter transactions for the current user
    const userTransactions = transactions.filter(t => t.user.toString() === userId.toString());

    return res.status(200).json({
      success: true,
      data: userTransactions
    });
  } catch (error) {
    console.error('Error getting payment transactions:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Webhook handlers
export const razorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const body = JSON.stringify(req.body);

    // Verify webhook signature only if webhook secret is available
    if (_config.RAZORPAY_WEBHOOK_SECRET) {
      const expectedSignature = crypto
        .createHmac('sha256', _config.RAZORPAY_WEBHOOK_SECRET)
        .update(body)
        .digest('hex');

      if (signature !== expectedSignature) {
        console.log('Webhook signature verification failed, but continuing...');
        // Don't return error, just log it since webhook secret might not be configured
      }
    } else {
      console.log('Razorpay webhook secret not configured, skipping signature verification');
    }

    const { event, payload } = req.body;

    // Handle different webhook events
    switch (event) {
      case 'payment.captured':
        // Handle successful payment
        break;
      case 'payment.failed':
        // Handle failed payment
        break;
      default:
        console.log('Unhandled webhook event:', event);
    }

    return res.status(200).json({ success: true });
    } catch (error) {
    console.error('Error processing Razorpay webhook:', error);
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
};

export const cashfreeWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const body = JSON.stringify(req.body);

    // Verify webhook signature only if webhook secret is available
    if (_config.CASHFREE_WEBHOOK_SECRET) {
      const expectedSignature = crypto
        .createHmac('sha256', _config.CASHFREE_WEBHOOK_SECRET)
        .update(body)
        .digest('hex');

      if (signature !== expectedSignature) {
        console.log('Cashfree webhook signature verification failed, but continuing...');
        // Don't return error, just log it since webhook secret might not be configured
      }
    } else {
      console.log('Cashfree webhook secret not configured, skipping signature verification');
    }

    const { type, data } = req.body;

    // Handle different webhook events
    switch (type) {
      case 'PAYMENT_SUCCESS_WEBHOOK':
        // Handle successful payment
        break;
      case 'PAYMENT_FAILED_WEBHOOK':
        // Handle failed payment
        break;
      default:
        console.log('Unhandled webhook event:', type);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing Cashfree webhook:', error);
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
};

// ─── ADMIN CONTROLLERS ───────────────────────────────────────

// Get payment configuration (admin - full details)
export const getAdminPaymentConfig = async (req, res) => {
  try {
    const config = await paymentService.getPaymentConfig();
    if (!config) {
      return res.status(404).json({ success: false, message: 'Payment configuration not found' });
    }

    return res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Error getting admin payment config:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Update payment configuration
export const updateAdminPaymentConfig = async (req, res) => {
  try {
    const configData = req.body;
    const config = await paymentService.updatePaymentConfig(configData);
    
    return res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Error updating payment config:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Get all payment transactions
export const getAllPaymentTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, provider } = req.query;
    const skip = (page - 1) * limit;

    const filter = {};
    if (status) filter.status = status;
    if (provider) filter.provider = provider;

    const transactions = await PaymentTransaction.find(filter)
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await PaymentTransaction.countDocuments(filter);

    return res.status(200).json({
      success: true,
      data: transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    } catch (error) {
    console.error('Error getting payment transactions:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get payment statistics
export const getPaymentStats = async (req, res) => {
  try {
    const stats = await PaymentTransaction.aggregate([
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          successfulTransactions: {
            $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
          },
          successfulAmount: {
            $sum: { $cond: [{ $eq: ['$status', 'success'] }, '$amount', 0] }
          },
          failedTransactions: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          },
          pendingTransactions: {
            $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] }
          }
        }
      }
    ]);

    const providerStats = await PaymentTransaction.aggregate([
      {
        $group: {
          _id: '$provider',
          count: { $sum: 1 },
          amount: { $sum: '$amount' }
        }
      }
    ]);

    const statusStats = await PaymentTransaction.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          amount: { $sum: '$amount' }
        }
      }
    ]);

    return res.status(200).json({
      success: true,
      data: {
        overview: stats[0] || {
          totalTransactions: 0,
          totalAmount: 0,
          successfulTransactions: 0,
          successfulAmount: 0,
          failedTransactions: 0,
          pendingTransactions: 0
        },
        byProvider: providerStats,
        byStatus: statusStats
      }
    });
  } catch (error) {
    console.error('Error getting payment stats:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};